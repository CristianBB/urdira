# Logical value error codes

Urdira v3 reports errors for logical-value validation and digest verification.
There is no versioned universal byte decoder. The active errors include
`uce:trailing_data`, `uce:non_canonical_encoding`, `uce:duplicate_map_key`,
`uce:invalid_utf8`, `uce:invalid_unicode_scalar`,
`uce:schema_validation_failed`, `uce:digest_mismatch`, and
`uce:resource_limit_exceeded`.

Worker batch validation additionally reports the owning stage, batch section,
row/column coordinate, configured byte or row limit, and observed value. A
transport failure never becomes a partial publication: only confirmed batches
are eligible for staging and publication.
