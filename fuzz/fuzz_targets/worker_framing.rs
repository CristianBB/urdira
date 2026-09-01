#![no_main]

use libfuzzer_sys::fuzz_target;
use urdira_fuzz::MAX_FUZZ_INPUT_BYTES;
use urdira_worker_protocol::{FrameDecoder, FrameOptions, decode_json, encode_message};

fuzz_target!(|input: &[u8]| {
    if input.len() > MAX_FUZZ_INPUT_BYTES {
        return;
    }

    let mut decoder = FrameDecoder::new(MAX_FUZZ_INPUT_BYTES);
    let mut offset = 0usize;
    while offset < input.len() {
        let width = usize::from(input[offset]) % 1_024 + 1;
        let end = offset.saturating_add(width).min(input.len());
        match decoder.push(&input[offset..end]) {
            Ok(messages) => {
                for message in messages {
                    let _ = decode_json::<serde_json::Value>(&message);
                }
            }
            Err(_) => break,
        }
        offset = end;
    }
    let _ = decoder.finish();

    let payload = &input[..input.len().min(4_096)];
    let options = FrameOptions {
        stream_id: 7,
        cancellation_id: "fuzz",
        byte_budget: MAX_FUZZ_INPUT_BYTES as u32,
        in_flight_budget: MAX_FUZZ_INPUT_BYTES as u32,
    };
    if let Ok(frames) = encode_message(&payload, &options) {
        let mut valid_decoder = FrameDecoder::new(MAX_FUZZ_INPUT_BYTES);
        let mut completed = Vec::new();
        for frame in frames {
            for chunk in frame.chunks(257) {
                completed.extend(
                    valid_decoder
                        .push(chunk)
                        .expect("encoded frame must decode"),
                );
            }
        }
        valid_decoder.finish().expect("encoded message must finish");
        assert_eq!(completed.len(), 1);
        let decoded: Vec<u8> = decode_json(&completed[0]).expect("encoded payload is closed JSON");
        assert_eq!(decoded, payload);
    }
});
