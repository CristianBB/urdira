#![no_main]

use libfuzzer_sys::fuzz_target;
use urdira_fuzz::{
    MAX_FUZZ_INPUT_BYTES, structured_fact_delta_batch, validate_fact_delta_stream_batch,
    validate_fact_delta_stream_batch_bytes,
};

fuzz_target!(|input: &[u8]| {
    if input.len() > MAX_FUZZ_INPUT_BYTES {
        return;
    }

    let _ = validate_fact_delta_stream_batch_bytes(input);

    let valid = structured_fact_delta_batch(input);
    validate_fact_delta_stream_batch(&valid).expect("bounded generated batch must validate");

    let mut invalid_count = valid.clone();
    invalid_count.row_count = invalid_count.row_count.saturating_add(1);
    assert!(validate_fact_delta_stream_batch(&invalid_count).is_err());

    let mut invalid_digest = valid;
    invalid_digest.chunk_digest.replace_range(7..8, "g");
    assert!(validate_fact_delta_stream_batch(&invalid_digest).is_err());
});
