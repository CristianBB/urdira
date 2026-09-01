use std::io::{Read, Write};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;
use urdira_jsts_syntax_worker::{
    AnalysisError, ErrorCode, HostMessage, SyntaxWorkerState, WorkerMessage, handshake,
};
use urdira_worker_protocol::{
    DecodedMessage, FrameDecoder, FrameOptions, MAX_MESSAGE_BYTES, decode_json, encode_message,
};

struct Inbound {
    frame: DecodedMessage,
    message: Result<HostMessage, String>,
}

struct Running {
    request_id: String,
    stream_id: u32,
    cancellation_id: String,
    output_budget: u32,
    cancel: Arc<AtomicBool>,
    result: mpsc::Receiver<Result<WorkerMessage, AnalysisError>>,
}

fn main() {
    let (input_tx, input_rx) = mpsc::channel::<Inbound>();
    thread::spawn(move || read_input(input_tx));
    let state = Arc::new(Mutex::new(SyntaxWorkerState::default()));
    let mut stdout = std::io::stdout().lock();
    let mut handshake_complete = false;
    let mut running: Option<Running> = None;

    loop {
        if let Some(active) = &running {
            match active.result.try_recv() {
                Ok(result) => {
                    let response = result.unwrap_or_else(|error| WorkerMessage::Error {
                        request_id: active.request_id.clone(),
                        code: error.code,
                        message: bounded(error.message),
                    });
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        active.stream_id,
                        &active.cancellation_id,
                        active.output_budget,
                    );
                    running = None;
                    continue;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    let response = WorkerMessage::Error {
                        request_id: active.request_id.clone(),
                        code: ErrorCode::AnalysisFailed,
                        message: "analysis task was lost".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        active.stream_id,
                        &active.cancellation_id,
                        active.output_budget,
                    );
                    running = None;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }

        let inbound = match input_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let message = match inbound.message {
            Ok(message) => message,
            Err(message) => {
                let response = WorkerMessage::Error {
                    request_id: "protocol:invalid".into(),
                    code: ErrorCode::ProtocolInvalid,
                    message: bounded(message),
                };
                let _ = write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    &inbound.frame.cancellation_id,
                    inbound.frame.byte_budget,
                );
                break;
            }
        };
        if !handshake_complete && !matches!(message, HostMessage::Handshake { .. }) {
            let response = WorkerMessage::Error {
                request_id: request_id(&message).into(),
                code: ErrorCode::HandshakeRequired,
                message: "handshake is required before worker commands".into(),
            };
            let _ = write_response(
                &mut stdout,
                &response,
                inbound.frame.stream_id,
                &inbound.frame.cancellation_id,
                inbound.frame.byte_budget,
            );
            break;
        }
        match message {
            HostMessage::Handshake {
                request_id,
                protocol_identity,
                protocol_version,
                expected_worker_build_identity,
                max_frame_chunk_bytes,
                max_message_bytes,
            } => {
                if handshake_complete {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::ProtocolInvalid,
                        message: "handshake may occur only once".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        "",
                        inbound.frame.byte_budget,
                    );
                    break;
                }
                match handshake(
                    request_id.clone(),
                    protocol_identity,
                    protocol_version,
                    expected_worker_build_identity,
                    max_frame_chunk_bytes,
                    max_message_bytes,
                ) {
                    Ok(response) => {
                        if write_response(
                            &mut stdout,
                            &response,
                            inbound.frame.stream_id,
                            "",
                            inbound.frame.byte_budget,
                        )
                        .is_err()
                        {
                            break;
                        }
                        handshake_complete = true;
                    }
                    Err(error) => {
                        let response = WorkerMessage::Error {
                            request_id,
                            code: error.code,
                            message: bounded(error.message),
                        };
                        let _ = write_response(
                            &mut stdout,
                            &response,
                            inbound.frame.stream_id,
                            "",
                            inbound.frame.byte_budget,
                        );
                        break;
                    }
                }
            }
            HostMessage::Analyze {
                request_id,
                cancellation_id,
                project_key,
                configuration_digest,
                root_names,
                files,
                change_set,
                budgets,
                config_assets,
            } => {
                if inbound.frame.cancellation_id != cancellation_id {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::ProtocolInvalid,
                        message: "frame and command cancellation identities differ".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        budgets.max_output_bytes,
                    );
                    break;
                }
                if running.is_some() {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::WorkerBusy,
                        message: "one syntax analysis is already running".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        budgets.max_output_bytes,
                    );
                    continue;
                }
                let worker_state = Arc::clone(&state);
                let running_request_id = request_id.clone();
                let cancel = Arc::new(AtomicBool::new(false));
                let task_cancel = Arc::clone(&cancel);
                let (result_tx, result_rx) = mpsc::channel();
                thread::spawn(move || {
                    let result = worker_state
                        .lock()
                        .map_err(|_| AnalysisError {
                            code: ErrorCode::AnalysisFailed,
                            message: "worker state lock is poisoned".into(),
                        })
                        .and_then(|mut state| {
                            state.analyze(
                                request_id,
                                cancellation_id,
                                project_key,
                                configuration_digest,
                                root_names,
                                files,
                                config_assets,
                                change_set,
                                budgets,
                                &task_cancel,
                            )
                        });
                    let _ = result_tx.send(result);
                });
                running = Some(Running {
                    request_id: running_request_id,
                    stream_id: inbound.frame.stream_id,
                    cancellation_id: inbound.frame.cancellation_id,
                    output_budget: budgets.max_output_bytes,
                    cancel,
                    result: result_rx,
                });
            }
            HostMessage::ReadFacts {
                request_id,
                cancellation_id,
                project_key,
                path,
                cursor,
                max_output_bytes,
                max_rows,
            } => {
                if inbound.frame.cancellation_id != cancellation_id {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::ProtocolInvalid,
                        message: "frame and command cancellation identities differ".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        max_output_bytes,
                    );
                    break;
                }
                if running.is_some() {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::WorkerBusy,
                        message: "facts are unavailable while analysis is running".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        max_output_bytes,
                    );
                    continue;
                }
                let response = state
                    .lock()
                    .map_err(|_| AnalysisError {
                        code: ErrorCode::AnalysisFailed,
                        message: "worker state lock is poisoned".into(),
                    })
                    .and_then(|state| {
                        state.read_facts(
                            request_id.clone(),
                            cancellation_id.clone(),
                            project_key,
                            path,
                            cursor,
                            max_output_bytes,
                            max_rows,
                        )
                    })
                    .unwrap_or_else(|error| WorkerMessage::Error {
                        request_id,
                        code: error.code,
                        message: bounded(error.message),
                    });
                if write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    &cancellation_id,
                    max_output_bytes,
                )
                .is_err()
                {
                    break;
                }
            }
            HostMessage::ReadFactsGroup {
                request_id,
                cancellation_id,
                project_key,
                entries,
                max_output_bytes,
                max_rows,
            } => {
                if inbound.frame.cancellation_id != cancellation_id {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::ProtocolInvalid,
                        message: "frame and command cancellation identities differ".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        max_output_bytes,
                    );
                    break;
                }
                if running.is_some() {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::WorkerBusy,
                        message: "facts are unavailable while analysis is running".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        max_output_bytes,
                    );
                    continue;
                }
                let response = state
                    .lock()
                    .map_err(|_| AnalysisError {
                        code: ErrorCode::AnalysisFailed,
                        message: "worker state lock is poisoned".into(),
                    })
                    .and_then(|state| {
                        state.read_facts_group(
                            request_id.clone(),
                            cancellation_id.clone(),
                            project_key,
                            entries,
                            max_output_bytes,
                            max_rows,
                        )
                    })
                    .unwrap_or_else(|error| WorkerMessage::Error {
                        request_id,
                        code: error.code,
                        message: bounded(error.message),
                    });
                if write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    &cancellation_id,
                    max_output_bytes,
                )
                .is_err()
                {
                    break;
                }
            }
            HostMessage::CommitAnalysis {
                request_id,
                project_key,
                analysis_token,
            } => {
                if running.is_some() {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::WorkerBusy,
                        message:
                            "analysis acknowledgement is unavailable while analysis is running"
                                .into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        "",
                        inbound.frame.byte_budget,
                    );
                    continue;
                }
                let response = state
                    .lock()
                    .map_err(|_| AnalysisError {
                        code: ErrorCode::AnalysisFailed,
                        message: "worker state lock is poisoned".into(),
                    })
                    .and_then(|mut state| {
                        state.commit_analysis(request_id.clone(), project_key, analysis_token)
                    })
                    .unwrap_or_else(|error| WorkerMessage::Error {
                        request_id,
                        code: error.code,
                        message: bounded(error.message),
                    });
                if write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    "",
                    inbound.frame.byte_budget,
                )
                .is_err()
                {
                    break;
                }
            }
            HostMessage::Cancel {
                request_id,
                cancellation_id,
            } => {
                if inbound.frame.cancellation_id != cancellation_id {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::ProtocolInvalid,
                        message: "frame and command cancellation identities differ".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        &cancellation_id,
                        inbound.frame.byte_budget,
                    );
                    break;
                }
                if let Some(active) = &running
                    && active.cancellation_id == cancellation_id
                {
                    active.cancel.store(true, Ordering::Release);
                }
                let response = WorkerMessage::CancelAck {
                    request_id,
                    cancellation_id: cancellation_id.clone(),
                };
                if write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    &cancellation_id,
                    inbound.frame.byte_budget,
                )
                .is_err()
                {
                    break;
                }
            }
            HostMessage::Reset {
                request_id,
                project_key,
            } => {
                if running.is_some() {
                    let response = WorkerMessage::Error {
                        request_id,
                        code: ErrorCode::WorkerBusy,
                        message: "reset is unavailable while analysis is running".into(),
                    };
                    let _ = write_response(
                        &mut stdout,
                        &response,
                        inbound.frame.stream_id,
                        "",
                        inbound.frame.byte_budget,
                    );
                    continue;
                }
                let reset_projects = state
                    .lock()
                    .map(|mut state| state.reset(project_key.as_deref()))
                    .unwrap_or(0);
                let response = WorkerMessage::ResetAck {
                    request_id,
                    reset_projects,
                };
                if write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    "",
                    inbound.frame.byte_budget,
                )
                .is_err()
                {
                    break;
                }
            }
            HostMessage::Shutdown { request_id } => {
                if let Some(active) = &running {
                    active.cancel.store(true, Ordering::Release);
                }
                let response = WorkerMessage::ShutdownAck { request_id };
                let _ = write_response(
                    &mut stdout,
                    &response,
                    inbound.frame.stream_id,
                    "",
                    inbound.frame.byte_budget,
                );
                break;
            }
        }
    }
}

fn read_input(sender: mpsc::Sender<Inbound>) {
    let mut stdin = std::io::stdin().lock();
    let mut decoder = FrameDecoder::default();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => match decoder.push(&buffer[..count]) {
                Ok(messages) => {
                    for frame in messages {
                        let message =
                            decode_json::<HostMessage>(&frame).map_err(|error| error.to_string());
                        if sender.send(Inbound { frame, message }).is_err() {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let frame = DecodedMessage {
                        stream_id: 0,
                        cancellation_id: String::new(),
                        byte_budget: MAX_MESSAGE_BYTES as u32,
                        in_flight_budget: MAX_MESSAGE_BYTES as u32,
                        payload: Vec::new(),
                    };
                    let _ = sender.send(Inbound {
                        frame,
                        message: Err(error.to_string()),
                    });
                    return;
                }
            },
            Err(_) => break,
        }
    }
}

fn write_response(
    output: &mut impl Write,
    response: &WorkerMessage,
    stream_id: u32,
    cancellation_id: &str,
    byte_budget: u32,
) -> std::io::Result<()> {
    let budget = byte_budget.max(1024).min(MAX_MESSAGE_BYTES as u32);
    let frames = encode_message(
        response,
        &FrameOptions {
            stream_id,
            cancellation_id,
            byte_budget: budget,
            in_flight_budget: budget,
        },
    )
    .map_err(std::io::Error::other)?;
    for frame in frames {
        output.write_all(&frame)?;
    }
    output.flush()
}

fn request_id(message: &HostMessage) -> &str {
    match message {
        HostMessage::Handshake { request_id, .. }
        | HostMessage::Analyze { request_id, .. }
        | HostMessage::ReadFacts { request_id, .. }
        | HostMessage::ReadFactsGroup { request_id, .. }
        | HostMessage::CommitAnalysis { request_id, .. }
        | HostMessage::Cancel { request_id, .. }
        | HostMessage::Reset { request_id, .. }
        | HostMessage::Shutdown { request_id } => request_id,
    }
}

fn bounded(message: String) -> String {
    message.chars().take(1024).collect()
}
