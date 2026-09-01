use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::{HashMap, HashSet};
use std::fmt::{Display, Formatter};

pub const PROTOCOL_IDENTITY: &str = "urdira.ipc.v2";
pub const PROTOCOL_VERSION: u8 = 3;
pub const MAX_FRAME_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Host-authoritative source transition scope carried separately from a
/// complete source manifest. `Full` is reserved for scans that have no safe
/// incremental basis; `Exact` carries the planner's complete changed-artifact
/// set, including an explicitly empty set.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthoritativeChangeSet {
    Full,
    Exact { changed_artifact_ids: Vec<String> },
}

/// Closed operation-level protocol used by the Rust indexing runtime. The
/// application sends one generation request and receives bounded progress;
/// owner rows never travel through the application process.
pub const INDEXING_CORE_PROTOCOL_IDENTITY: &str = "urdira.indexing-core.v1";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IndexingEngineDescriptor {
    pub engine_id: String,
    pub engine_version: String,
    pub implementation_digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IndexingGenerationRequest {
    pub operation_id: String,
    pub workspace_id: String,
    pub candidate_generation_id: String,
    pub database_path: String,
    /// Private filesystem cancellation signal created by the process
    /// transport. The worker polls it at Rust checkpoints because the framed
    /// command loop is intentionally synchronous while a generation runs.
    #[serde(default)]
    pub cancellation_path: Option<String>,
    /// Private cutover flag: Rust may install final v3 rows directly from its
    /// typed TEMP relation, retaining only bounded candidate metadata.
    #[serde(default)]
    pub direct_publication: bool,
    pub source_snapshot_id: String,
    /// Explicit immutable CAS coordinate for the captured source generation.
    /// The selected engine may use only source blobs beneath this root.
    pub cas_root: String,
    pub source_state_digest: String,
    pub base_generation: u64,
    pub registry_snapshot_id: String,
    pub configuration_revision_id: String,
    pub resolution_lock_id: String,
    /// Digest of the shared workspace-v3 SQL authority.
    #[serde(default)]
    pub workspace_schema_digest: Option<String>,
    pub change_set: AuthoritativeChangeSet,
    /// Generic core-owned candidate lifecycle metadata. Engines do not own
    /// candidate rows; these values are persisted by Rust before staging.
    #[serde(default)]
    pub candidate: Option<serde_json::Value>,
    #[serde(default)]
    pub frozen_base: Option<serde_json::Value>,
    #[serde(default)]
    pub work_manifest: Option<serde_json::Value>,
    pub engine: IndexingEngineDescriptor,
    pub deadline_ms: Option<u64>,
    /// Optional engine-owned source capture. The generic core treats this as
    /// opaque; the JS/TS engine consumes it inside the Rust worker so the
    /// application process never schedules or materialises owner rows.
    #[serde(default)]
    pub engine_input: Option<serde_json::Value>,
    /// Optional Rust-owned JS/TS semantic checker descriptor. The composition
    /// worker launches this private process and keeps its protocol boundary
    /// outside the application runtime.
    #[serde(default)]
    pub semantic_engine: Option<SemanticEngineDescriptor>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SemanticEngineDescriptor {
    pub node_executable: String,
    pub worker_entrypoint: String,
    pub build_identity: String,
    pub worker_descriptor: serde_json::Value,
    #[serde(default)]
    pub structural_kernel_addon_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[allow(clippy::large_enum_variant)]
pub enum IndexingCommand {
    Handshake {
        request_id: String,
        protocol_identity: String,
    },
    IndexGeneration {
        request_id: String,
        request: IndexingGenerationRequest,
    },
    /// Internal bounded receiver hook. Production language engines use this
    /// only inside the worker; the application never sees owner rows.
    AcceptGroup {
        request_id: String,
        operation_id: String,
        group: serde_json::Value,
    },
    AcceptCanonicalGroup {
        request_id: String,
        operation_id: String,
        group: serde_json::Value,
    },
    /// Rust-owned semantic checker invocation. The request is an opaque
    /// plugin envelope; owner rows never return to the application process.
    AnalyzeSemanticGroup {
        request_id: String,
        operation_id: String,
        requests: Vec<serde_json::Value>,
    },
    InvokeSemantic {
        request_id: String,
        operation_id: String,
        request: serde_json::Value,
    },
    FinalizeGeneration {
        request_id: String,
        operation_id: String,
        #[serde(default)]
        publication: Option<serde_json::Value>,
    },
    /// Generic source-catalog commit used when a scan has no structural
    /// candidate (for example an equivalent incremental rescan).
    SourceIndexCommit {
        request_id: String,
        operation_id: String,
        workspace_id: String,
        database_path: String,
        commits: Vec<serde_json::Value>,
        /// Apply source rows but defer advancing source_index_state until the
        /// final chunk of a large capture arrives.
        #[serde(default = "default_true")]
        finalize_state: bool,
    },
    /// Roll back a source layer that was staged by a failed first-generation
    /// fork. This keeps recovery on the same Rust writer boundary as commit.
    SourceIndexRollback {
        request_id: String,
        operation_id: String,
        workspace_id: String,
        database_path: String,
    },
    Cancel {
        request_id: String,
        operation_id: String,
    },
    Status {
        request_id: String,
        operation_id: String,
    },
    Shutdown {
        request_id: String,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IndexingEvent {
    HandshakeAck {
        request_id: String,
        protocol_identity: String,
        protocol_version: u16,
    },
    Progress {
        request_id: String,
        operation_id: String,
        phase: String,
        completed_groups: u64,
        completed_owners: u64,
        completed_rows: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        affected_paths: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        changed_paths: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dependency_graph: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        analysis_token: Option<String>,
    },
    SemanticResult {
        request_id: String,
        operation_id: String,
        result: serde_json::Value,
    },
    Completed {
        request_id: String,
        operation_id: String,
        generation: u64,
        group_count: u64,
        owner_count: u64,
        row_count: u64,
        ordered_digest: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lexical_closed: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lexical_inserted: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lexical_oversized: Option<u64>,
    },
    Cancelled {
        request_id: String,
        operation_id: String,
    },
    Status {
        request_id: String,
        operation_id: String,
        phase: String,
        active: bool,
    },
    ShutdownAck {
        request_id: String,
    },
    SourceIndexCommitted {
        request_id: String,
        operation_id: String,
        commit_count: u64,
    },
    SourceIndexRolledBack {
        request_id: String,
        operation_id: String,
    },
    Error {
        request_id: String,
        code: String,
        message: String,
    },
}

const PROTOBUF_FRAME_VERSION: u32 = 2;
const MAX_PROTOBUF_FRAME_OVERHEAD_BYTES: usize = 320;
const WIRE_VARINT: u32 = 0;
const WIRE_LENGTH_DELIMITED: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl Display for ProtocolError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameOptions<'a> {
    pub stream_id: u32,
    pub cancellation_id: &'a str,
    pub byte_budget: u32,
    pub in_flight_budget: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedMessage {
    pub stream_id: u32,
    pub cancellation_id: String,
    pub byte_budget: u32,
    pub in_flight_budget: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug)]
struct PendingStream {
    cancellation_id: String,
    byte_budget: u32,
    in_flight_budget: u32,
    next_sequence: u32,
    next_offset: u32,
    payload: Vec<u8>,
}

pub fn encode_message<T: Serialize>(
    value: &T,
    options: &FrameOptions<'_>,
) -> Result<Vec<Vec<u8>>, ProtocolError> {
    validate_identifier(options.cancellation_id, true)?;
    if options.byte_budget == 0 || options.in_flight_budget == 0 {
        return Err(ProtocolError(
            "byte and in-flight budgets must be positive".into(),
        ));
    }
    let payload = serde_json::to_vec(value)
        .map_err(|_| ProtocolError("message serialization failed".into()))?;
    let limit = usize::try_from(options.byte_budget.min(options.in_flight_budget))
        .unwrap_or(usize::MAX)
        .min(MAX_MESSAGE_BYTES);
    if payload.len() > limit {
        return Err(ProtocolError("message exceeds its mandatory budget".into()));
    }
    let cancellation = options.cancellation_id.as_bytes();
    let max_payload = MAX_FRAME_CHUNK_BYTES
        .checked_sub(MAX_PROTOBUF_FRAME_OVERHEAD_BYTES + cancellation.len())
        .ok_or_else(|| ProtocolError("cancellation id leaves no frame payload budget".into()))?;
    if max_payload == 0 {
        return Err(ProtocolError(
            "cancellation id leaves no frame payload budget".into(),
        ));
    }
    let mut frames = Vec::new();
    let mut offset = 0usize;
    let mut sequence = 0u32;
    loop {
        let payload_length = (payload.len() - offset).min(max_payload);
        let final_frame = offset + payload_length == payload.len();
        let mut body = Vec::with_capacity(
            MAX_PROTOBUF_FRAME_OVERHEAD_BYTES + cancellation.len() + payload_length,
        );
        write_varint_field(&mut body, 1, PROTOBUF_FRAME_VERSION);
        write_varint_field(&mut body, 2, options.stream_id);
        write_varint_field(&mut body, 3, sequence);
        write_varint_field(
            &mut body,
            4,
            u32::try_from(offset)
                .map_err(|_| ProtocolError("message offset is too large".into()))?,
        );
        write_varint_field(&mut body, 5, options.byte_budget);
        write_varint_field(&mut body, 6, options.in_flight_budget);
        write_bytes_field(&mut body, 7, cancellation)?;
        write_bytes_field(&mut body, 8, &payload[offset..offset + payload_length])?;
        write_varint_field(&mut body, 9, u32::from(final_frame));
        if body.len() > MAX_FRAME_CHUNK_BYTES {
            return Err(ProtocolError(
                "Protobuf frame exceeds its chunk budget".into(),
            ));
        }
        let mut frame = Vec::with_capacity(4 + body.len());
        frame.extend_from_slice(
            &u32::try_from(body.len())
                .map_err(|_| ProtocolError("frame is too large".into()))?
                .to_be_bytes(),
        );
        frame.extend_from_slice(&body);
        frames.push(frame);
        offset += payload_length;
        sequence = sequence
            .checked_add(1)
            .ok_or_else(|| ProtocolError("too many frame chunks".into()))?;
        if final_frame {
            break;
        }
    }
    Ok(frames)
}

fn write_varint(output: &mut Vec<u8>, mut value: u32) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            return;
        }
    }
}

fn write_varint_field(output: &mut Vec<u8>, field: u32, value: u32) {
    write_varint(output, field * 8 + WIRE_VARINT);
    write_varint(output, value);
}

fn write_bytes_field(output: &mut Vec<u8>, field: u32, value: &[u8]) -> Result<(), ProtocolError> {
    write_varint(output, field * 8 + WIRE_LENGTH_DELIMITED);
    write_varint(
        output,
        u32::try_from(value.len())
            .map_err(|_| ProtocolError("Protobuf bytes field is too large".into()))?,
    );
    output.extend_from_slice(value);
    Ok(())
}

struct ProtobufFrame<'a> {
    stream_id: u32,
    sequence: u32,
    offset: u32,
    byte_budget: u32,
    in_flight_budget: u32,
    cancellation_id: String,
    payload: &'a [u8],
    final_frame: bool,
}

fn read_varint(input: &[u8], cursor: &mut usize) -> Result<u32, ProtocolError> {
    let mut value = 0u32;
    for shift in [0, 7, 14, 21, 28] {
        let byte = *input
            .get(*cursor)
            .ok_or_else(|| ProtocolError("Protobuf varint is truncated".into()))?;
        *cursor += 1;
        if shift == 28 && byte & 0xf0 != 0 {
            return Err(ProtocolError("Protobuf varint exceeds uint32".into()));
        }
        value |= u32::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(ProtocolError("Protobuf varint exceeds uint32".into()))
}

fn read_bytes<'a>(input: &'a [u8], cursor: &mut usize) -> Result<&'a [u8], ProtocolError> {
    let length = usize::try_from(read_varint(input, cursor)?).unwrap_or(usize::MAX);
    let end = cursor
        .checked_add(length)
        .filter(|end| *end <= input.len())
        .ok_or_else(|| ProtocolError("Protobuf bytes field is truncated".into()))?;
    let value = &input[*cursor..end];
    *cursor = end;
    Ok(value)
}

fn decode_frame(input: &[u8]) -> Result<ProtobufFrame<'_>, ProtocolError> {
    let mut cursor = 0usize;
    let mut seen = HashSet::new();
    let mut version = None;
    let mut stream_id = None;
    let mut sequence = None;
    let mut offset = None;
    let mut byte_budget = None;
    let mut in_flight_budget = None;
    let mut cancellation = None;
    let mut payload = None;
    let mut final_frame = None;
    while cursor < input.len() {
        let tag = read_varint(input, &mut cursor)?;
        let field = tag / 8;
        let wire = tag % 8;
        if !(1..=9).contains(&field) || !seen.insert(field) {
            return Err(ProtocolError(
                "Protobuf frame has an unknown or duplicate field".into(),
            ));
        }
        match field {
            1..=6 | 9 => {
                if wire != WIRE_VARINT {
                    return Err(ProtocolError(
                        "Protobuf scalar has the wrong wire type".into(),
                    ));
                }
                let value = read_varint(input, &mut cursor)?;
                match field {
                    1 => version = Some(value),
                    2 => stream_id = Some(value),
                    3 => sequence = Some(value),
                    4 => offset = Some(value),
                    5 => byte_budget = Some(value),
                    6 => in_flight_budget = Some(value),
                    9 => final_frame = Some(value),
                    _ => unreachable!(),
                }
            }
            7 | 8 => {
                if wire != WIRE_LENGTH_DELIMITED {
                    return Err(ProtocolError(
                        "Protobuf bytes have the wrong wire type".into(),
                    ));
                }
                let value = read_bytes(input, &mut cursor)?;
                if field == 7 {
                    cancellation = Some(value);
                } else {
                    payload = Some(value);
                }
            }
            _ => unreachable!(),
        }
    }
    if seen.len() != 9 || version != Some(PROTOBUF_FRAME_VERSION) {
        return Err(ProtocolError(
            "Protobuf frame version or required fields are invalid".into(),
        ));
    }
    let cancellation_id = std::str::from_utf8(cancellation.expect("required field was checked"))
        .map_err(|_| ProtocolError("cancellation id is not UTF-8".into()))?;
    validate_identifier(cancellation_id, true)?;
    let final_frame = final_frame.expect("required field was checked");
    if final_frame > 1 {
        return Err(ProtocolError("Protobuf final flag is invalid".into()));
    }
    let byte_budget = byte_budget.expect("required field was checked");
    let in_flight_budget = in_flight_budget.expect("required field was checked");
    if byte_budget == 0 || in_flight_budget == 0 {
        return Err(ProtocolError("frame budgets must be positive".into()));
    }
    Ok(ProtobufFrame {
        stream_id: stream_id.expect("required field was checked"),
        sequence: sequence.expect("required field was checked"),
        offset: offset.expect("required field was checked"),
        byte_budget,
        in_flight_budget,
        cancellation_id: cancellation_id.to_owned(),
        payload: payload.expect("required field was checked"),
        final_frame: final_frame == 1,
    })
}

pub fn decode_json<T: DeserializeOwned>(message: &DecodedMessage) -> Result<T, ProtocolError> {
    serde_json::from_slice(&message.payload)
        .map_err(|error| ProtocolError(format!("closed message decoding failed: {error}")))
}

pub struct FrameDecoder {
    buffered: Vec<u8>,
    streams: HashMap<u32, PendingStream>,
    max_message_bytes: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(MAX_MESSAGE_BYTES)
    }
}

impl FrameDecoder {
    pub fn new(max_message_bytes: usize) -> Self {
        Self {
            buffered: Vec::new(),
            streams: HashMap::new(),
            max_message_bytes: max_message_bytes.min(MAX_MESSAGE_BYTES),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<DecodedMessage>, ProtocolError> {
        self.buffered.extend_from_slice(chunk);
        let mut completed = Vec::new();
        loop {
            if self.buffered.len() < 4 {
                break;
            }
            let body_length = usize::try_from(u32::from_be_bytes(
                self.buffered[..4].try_into().expect("four-byte prefix"),
            ))
            .unwrap_or(usize::MAX);
            if !(1..=MAX_FRAME_CHUNK_BYTES).contains(&body_length) {
                return Err(ProtocolError("frame length is invalid".into()));
            }
            let frame_length = 4 + body_length;
            if self.buffered.len() < frame_length {
                break;
            }
            let body = self.buffered[4..frame_length].to_vec();
            self.buffered.drain(..frame_length);
            if let Some(message) = self.accept_frame(&body)? {
                completed.push(message);
            }
        }
        Ok(completed)
    }

    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.buffered.is_empty() && self.streams.is_empty() {
            Ok(())
        } else {
            Err(ProtocolError(
                "stream ended with an incomplete frame or message".into(),
            ))
        }
    }

    fn accept_frame(&mut self, body: &[u8]) -> Result<Option<DecodedMessage>, ProtocolError> {
        let frame = decode_frame(body)?;
        let ProtobufFrame {
            stream_id,
            sequence,
            offset,
            byte_budget,
            in_flight_budget,
            cancellation_id,
            payload,
            final_frame,
        } = frame;
        let pending = self
            .streams
            .entry(stream_id)
            .or_insert_with(|| PendingStream {
                cancellation_id: cancellation_id.clone(),
                byte_budget,
                in_flight_budget,
                next_sequence: 0,
                next_offset: 0,
                payload: Vec::new(),
            });
        if pending.cancellation_id != cancellation_id
            || pending.byte_budget != byte_budget
            || pending.in_flight_budget != in_flight_budget
        {
            return Err(ProtocolError(
                "stream metadata changed between chunks".into(),
            ));
        }
        if sequence != pending.next_sequence || offset != pending.next_offset {
            return Err(ProtocolError(
                "chunks are missing, duplicated, or out of order".into(),
            ));
        }
        let next_size = pending
            .payload
            .len()
            .checked_add(payload.len())
            .ok_or_else(|| ProtocolError("message length overflow".into()))?;
        let budget = usize::try_from(byte_budget.min(in_flight_budget))
            .unwrap_or(usize::MAX)
            .min(self.max_message_bytes);
        if next_size > budget {
            return Err(ProtocolError("message exceeds a mandatory budget".into()));
        }
        pending.payload.extend_from_slice(payload);
        pending.next_offset = u32::try_from(next_size)
            .map_err(|_| ProtocolError("message offset is too large".into()))?;
        pending.next_sequence = pending
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| ProtocolError("too many chunks".into()))?;
        if !final_frame {
            return Ok(None);
        }
        let completed = self
            .streams
            .remove(&stream_id)
            .expect("pending stream exists");
        Ok(Some(DecodedMessage {
            stream_id,
            cancellation_id: completed.cancellation_id,
            byte_budget,
            in_flight_budget,
            payload: completed.payload,
        }))
    }
}

fn validate_identifier(value: &str, allow_empty: bool) -> Result<(), ProtocolError> {
    if (!allow_empty && value.is_empty())
        || value.len() > 240
        || value
            .bytes()
            .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
    {
        Err(ProtocolError("protocol identifier is invalid".into()))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(deny_unknown_fields)]
    struct Example {
        kind: String,
        payload: String,
    }

    #[test]
    fn chunked_round_trip_is_bounded() {
        let value = Example {
            kind: "example".into(),
            payload: "a".repeat(MAX_FRAME_CHUNK_BYTES * 2),
        };
        let frames = encode_message(
            &value,
            &FrameOptions {
                stream_id: 9,
                cancellation_id: "cancel:9",
                byte_budget: 2_000_000,
                in_flight_budget: 2_000_000,
            },
        )
        .unwrap();
        assert!(frames.len() > 1);
        assert!(
            frames.iter().all(
                |frame| u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize
                    <= MAX_FRAME_CHUNK_BYTES
            )
        );
        let mut decoder = FrameDecoder::default();
        let mut messages = Vec::new();
        for frame in frames {
            messages.extend(decoder.push(&frame).unwrap());
        }
        decoder.finish().unwrap();
        assert_eq!(decode_json::<Example>(&messages[0]).unwrap(), value);
    }

    #[test]
    fn closed_json_rejects_unknown_and_duplicate_fields() {
        let message = DecodedMessage {
            stream_id: 1,
            cancellation_id: String::new(),
            byte_budget: 1024,
            in_flight_budget: 1024,
            payload: br#"{"kind":"example","payload":"ok","extra":true}"#.to_vec(),
        };
        assert!(decode_json::<Example>(&message).is_err());
        let duplicate = DecodedMessage {
            payload: br#"{"kind":"example","kind":"again","payload":"ok"}"#.to_vec(),
            ..message
        };
        assert!(decode_json::<Example>(&duplicate).is_err());
    }

    #[test]
    fn authoritative_change_set_distinguishes_full_from_exact_empty_and_is_closed() {
        assert_eq!(
            serde_json::from_str::<AuthoritativeChangeSet>(r#"{"kind":"full"}"#).unwrap(),
            AuthoritativeChangeSet::Full
        );
        assert_eq!(
            serde_json::from_str::<AuthoritativeChangeSet>(
                r#"{"kind":"exact","changed_artifact_ids":[]}"#
            )
            .unwrap(),
            AuthoritativeChangeSet::Exact {
                changed_artifact_ids: Vec::new()
            }
        );
        assert!(
            serde_json::from_str::<AuthoritativeChangeSet>(
                r#"{"kind":"exact","changed_artifact_ids":[],"files":[]}"#
            )
            .is_err()
        );
        assert!(serde_json::from_str::<AuthoritativeChangeSet>(r#"{"kind":"exact"}"#).is_err());
    }

    #[test]
    fn indexing_generation_protocol_is_closed_and_round_trips() {
        let command = IndexingCommand::IndexGeneration {
            request_id: "request:1".into(),
            request: IndexingGenerationRequest {
                operation_id: "operation:1".into(),
                workspace_id: "workspace:1".into(),
                candidate_generation_id: "candidate:1".into(),
                database_path: "/tmp/workspace.sqlite".into(),
                cancellation_path: None,
                direct_publication: false,
                source_snapshot_id: "snapshot:1".into(),
                cas_root: "/tmp/urdira-cas".into(),
                source_state_digest: "sha256:source".into(),
                base_generation: 4,
                registry_snapshot_id: "registry:1".into(),
                configuration_revision_id: "configuration:1".into(),
                resolution_lock_id: "resolution:1".into(),
                workspace_schema_digest: None,
                change_set: AuthoritativeChangeSet::Exact {
                    changed_artifact_ids: vec!["artifact:1".into()],
                },
                candidate: None,
                frozen_base: None,
                work_manifest: None,
                engine: IndexingEngineDescriptor {
                    engine_id: "urdira:jsts".into(),
                    engine_version: "1".into(),
                    implementation_digest: "sha256:engine".into(),
                },
                deadline_ms: Some(45_000),
                engine_input: None,
                semantic_engine: None,
            },
        };
        let encoded = serde_json::to_vec(&command).unwrap();
        assert_eq!(
            serde_json::from_slice::<IndexingCommand>(&encoded).unwrap(),
            command
        );
        assert!(
            serde_json::from_slice::<IndexingCommand>(
                br#"{"kind":"status","request_id":"r","operation_id":"o","unexpected":true}"#
            )
            .is_err()
        );
    }

    #[test]
    fn semantic_bridge_commands_are_closed_and_round_trip() {
        let command = IndexingCommand::AnalyzeSemanticGroup {
            request_id: "request:semantic".into(),
            operation_id: "operation:semantic".into(),
            requests: vec![serde_json::json!({
                "protocol_version": "1.0.0",
                "request_id": "owner:1",
                "call": "analyze_artifact"
            })],
        };
        let encoded = serde_json::to_vec(&command).unwrap();
        assert_eq!(
            serde_json::from_slice::<IndexingCommand>(&encoded).unwrap(),
            command
        );
        assert!(serde_json::from_slice::<IndexingCommand>(
            br#"{"kind":"invoke_semantic","request_id":"r","operation_id":"o","request":{},"extra":true}"#
        ).is_err());
    }

    #[test]
    fn source_index_commit_command_is_closed_and_round_trips() {
        let command = IndexingCommand::SourceIndexCommit {
            request_id: "request:source".into(),
            operation_id: "operation:source".into(),
            workspace_id: "workspace:source".into(),
            database_path: "/tmp/workspace.sqlite".into(),
            commits: vec![serde_json::json!({
                "expected_state_revision": 0,
                "state": {"workspace_id": "workspace:source"},
                "batch": {"workspace_id": "workspace:source"}
            })],
            finalize_state: true,
        };
        let encoded = serde_json::to_vec(&command).unwrap();
        assert_eq!(
            serde_json::from_slice::<IndexingCommand>(&encoded).unwrap(),
            command
        );
        assert!(serde_json::from_slice::<IndexingCommand>(
            br#"{"kind":"source_index_commit","request_id":"r","operation_id":"o","workspace_id":"w","database_path":"/tmp/db","commits":[],"extra":true}"#
        )
        .is_err());
        let rollback = IndexingCommand::SourceIndexRollback {
            request_id: "request:rollback".into(),
            operation_id: "operation:rollback".into(),
            workspace_id: "workspace:source".into(),
            database_path: "/tmp/workspace.sqlite".into(),
        };
        let encoded = serde_json::to_vec(&rollback).unwrap();
        assert_eq!(
            serde_json::from_slice::<IndexingCommand>(&encoded).unwrap(),
            rollback
        );
    }
}
