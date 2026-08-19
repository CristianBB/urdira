# Urdira Canonical Encoding

Status: **Approved**  
Last updated: 2026-08-07  
Governing model: [Universal data model](../decisions/01-universal-data-model.md)

## Purpose

Urdira Canonical Encoding (UCE) is the normative typed byte representation used for digests, integrity verification, portable persistence, and deterministic interchange between Urdira implementations. UCE is not the public MCP representation. Agent-facing requests and responses use concise JSON projections of the same logical values and are never hashed directly.

UCE v1 is a strict deterministic profile of CBOR. The same schema-valid logical value must produce exactly the same bytes and digest in TypeScript, Rust, and every other conforming implementation.

## Contract layers

```text
Public MCP JSON
  -> request normalization or result projection
  -> schema-valid logical value
  -> UCE v1 deterministic CBOR
  -> domain-separated digest envelope
  -> SHA-256 Digest
```

Public JSON field order, insignificant whitespace, and client-specific JSON number spelling never affect a digest. Defaults are resolved before a canonical model is constructed.

## UCE v1 CBOR profile

UCE v1 follows the core deterministic encoding requirements of [RFC 8949](https://www.rfc-editor.org/rfc/rfc8949) and further restricts the accepted data model:

- One UCE document contains exactly one root value and no trailing bytes.
- Every length is definite and uses its shortest valid representation.
- Integers, tags, simple values, and collection headers use their shortest valid representation.
- Map keys are sorted in bytewise lexicographic order of their deterministic CBOR encodings.
- Duplicate map keys are rejected before any value can overwrite another.
- Floating-point values use the shortest CBOR width that reproduces the exact logical binary64 value.
- Non-finite floats, `undefined`, unassigned simple values, shared references, embedded CBOR, and unknown tags are forbidden. Negative zero is not a distinct UCE logical value: a public numeric input is normalized to positive zero during model construction, while an incoming CBOR value encoded as negative zero is rejected as `uce:forbidden_cbor_feature`.
- Only the standard tags needed for arbitrary integers and decimal fractions are accepted.
- Every model is a closed CBOR map with exact text field names. The digest envelope and the internal representations of typed scalars are protocol tuples, not model records.
- A decodable but non-canonical input is rejected rather than silently normalized.
- Decoders enforce configured depth, byte, text, and element-count limits before allocating unbounded resources. A limit changes acceptance policy, never the canonical bytes of an accepted value.

## Logical scalar types

### Text

`Text` is a sequence of valid Unicode scalar values encoded as strict UTF-8. Lone surrogates, malformed UTF-8, and overlong representations are rejected. UCE performs no NFC, NFD, case, locale, or compatibility normalization. Comparison and canonical ordering use the exact UTF-8 bytes.

Model field names are ASCII `snake_case`. A plugin may expose an explicit derived normalized search value, but it cannot replace or silently normalize source text, identifiers, paths, or snippets.

### Bytes

`Bytes` is a native CBOR byte string. Its public JSON projection is exactly `base64url:<unpadded-value>` using the URL-safe alphabet from [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648). Arrays of octets, padded Base64, standard-alphabet Base64, and hexadecimal aliases are rejected as public `Bytes` values.

### Digest

`Digest` is a typed scalar. Its public JSON projection is:

```text
sha256:<exactly-64-lowercase-hexadecimal-digits>
```

UCE encodes it as the protocol tuple `[algorithm, digest_bytes]`. UCE v1 requires `algorithm` to be `sha256` and `digest_bytes` to contain exactly 32 bytes. Uppercase hexadecimal, omitted algorithm names, whitespace, and alternative encodings are invalid.

UCE v1's authoritative `HashAlgorithmDefinition` has `hash_algorithm: sha256`, `definition_revision: 1`, `schema_version: 1`, `digest_byte_length: 32`, `specification_uri: https://csrc.nist.gov/pubs/fips/180-4/upd1/final`, `lifecycle_state: active`, and description `SHA-256 as specified by FIPS 180-4`. Lifecycle markers and replacement are absent. Plugins cannot register hash algorithms.

The digest text does not repeat its domain, recipe, schema, or UCE version. Those values are pinned by the registered recipe governing the field and are present in the hashed envelope.

### Numeric types

Schemas distinguish numeric kinds; implicit conversion between them is forbidden.

| Logical type | Public JSON projection | Canonical behavior |
|---|---|---|
| `SafeInteger` | JSON integer | Exact range `-(2^53 - 1)` through `2^53 - 1`; shortest CBOR integer. |
| `BigInteger` | `bigint:<canonical-decimal-integer>` | Arbitrary precision; native CBOR integer when possible and standard positive or negative bignum otherwise. No plus sign or leading zero is allowed; zero is `bigint:0`. |
| `Float64` | JSON number | Finite IEEE 754 binary64 value; shortest CBOR float preserving the exact value; `-0` becomes `0`; NaN and infinities are rejected. |
| `ExactDecimal` | `decimal:<canonical-plain-decimal>` | Standard CBOR decimal-fraction representation. A significant-scale schema preserves trailing fractional zeros; an insignificant-scale schema removes them and canonicalizes zero to scale zero. Exponent notation, a leading plus, and redundant leading zeros are not public canonical forms. |

Original source-literal spelling is retained separately as source text whenever spelling carries language meaning. A derived numeric value never replaces the source bytes.

### Timestamp

`Timestamp` represents one UTC instant at nanosecond precision. Its public form is the restricted RFC 3339 representation:

```text
YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ
```

Canonical timestamps always use UTC, exactly nine fractional digits, the Gregorian calendar, and years from `0001` through `9999`. Offsets and other valid RFC 3339 input forms may be accepted at a public request boundary but are normalized before model construction. Leap-second values are rejected. UCE encodes a timestamp as the exact signed integer count of nanoseconds from the Unix epoch. `Duration` is a separate logical type.

### Absence and null

- An absent optional field is omitted.
- `null` is legal only when the selected schema type explicitly includes `null`.
- Absence and present `null` are different logical values.
- `undefined` and language-specific absence sentinels are forbidden.
- Canonical persisted schemas have no implicit defaults.
- Public API defaults are resolved and materialized before a canonical value is built or hashed.
- Unknown fields are rejected.

## Collections

Schemas distinguish four collection semantics:

- `Sequence<T>` preserves semantic order and permits duplicates.
- `Set<T>` rejects duplicates and orders values by their complete canonical element bytes.
- `OrderedSet<T>` rejects duplicates and uses an immutable registered comparator. Canonical element bytes break comparator ties. Comparator identifier and version are part of the governing schema and therefore the digest contract.
- `Map<T>` has dynamic exact text keys and schema-governed values. Keys are unique and use deterministic CBOR map ordering.

`Record` is distinct from `Map`: a record has a closed statically named field set, while a map has data-defined text keys. A structure needing non-text keys is represented as a sequence or set of closed `{key, value}` records.

Result ordering and pagination ordering are operation contracts and are not inferred from UCE's internal set order.

Comparator definitions use the portable structural model in the universal data model. The initial core values are authoritative in [Core canonical comparators](core-canonical-comparators.md). Executable callbacks, locale collation, and platform-native object ordering are invalid comparator definitions.

## Enums, unions, and extensions

- Closed enums use canonical ASCII `snake_case` text values.
- Globally extensible identifiers are namespaced, such as `core:function` or `typescript:interface`.
- Every union has one mandatory schema-declared discriminator.
- A variant is never inferred from the presence or absence of other fields.
- Each variant is a closed record and its discriminator participates in digests.
- Plugin schemas may use only registered UCE logical types and exact schema references.
- Arbitrary JSON, `any`, unknown fields, and producer-defined executable validators are forbidden in canonical data.

## Canonical schemas

The exact Schema IR models are defined only in the [universal data model](../decisions/01-universal-data-model.md). `CanonicalSchemaDefinition` is the immutable normative representation. TypeScript helpers, CDDL, JSON Schema, or another authoring syntax may be offered, but activation must compile author input to the same Schema IR before validation and hashing.

Schema identifiers are namespaced. Published schema versions are immutable. A field, type, presence, collection, default-normalization, discriminator, variant, or canonical-semantic change requires another `schema_version`. Historical versions remain available while referenced by retained snapshots. Unknown schemas or versions are never interpreted approximately.

Schema references are acyclic in UCE v1. Recursive source structures are represented by finite records connected through identifiers rather than recursively nested canonical values.

## Canonical paths and source bytes

A physical artifact's canonical path is relative to its workspace root. It uses `/`, has no leading or trailing separator, and contains no empty, `.` or `..` component. Escapes above the workspace root are rejected. Case and Unicode scalar sequences are preserved exactly.

Absolute roots, drive letters, operating-system conventions, and display paths are operational or presentation data. They do not define artifact identity or enter portable source-address digests. Moving a workspace root does not change its artifact identities. `(workspace_id, normalized_path)` remains indexed for exact update and closure.

`ArtifactVersion.content_hash` and `ContentBlob.content_hash` cover the exact raw source bytes read from the provider. BOMs, encodings, line endings, and non-text bytes are preserved. Decoded text used by parsers, snippets, or embeddings is a separately provenanced projection. A source capture that changes during reading is rejected or retried and cannot publish mixed bytes.

## Digest envelope

No Urdira digest hashes a bare value. The preimage is the UCE encoding of this exact nine-element protocol tuple:

```text
[
  "urdira",
  canonical_encoding_version,
  digest_domain,
  digest_recipe_id,
  recipe_version,
  payload_schema_id,
  payload_schema_version,
  hash_algorithm,
  payload
]
```

UCE v1 sets `canonical_encoding_version` to `1` and requires `hash_algorithm` to be `sha256`. The result is exposed as a canonical `Digest`.

Including every contract coordinate creates separate digest spaces for changes to encoding, domain, recipe, payload schema, or algorithm. The envelope is the sole framing mechanism; ad-hoc string concatenation and unframed byte hashing are forbidden.

## Digest recipes

Every field of type `Digest` has exactly one applicable immutable digest-field contract. A `DigestRecipeDefinition` computes a new digest; a `DigestReferenceDefinition` validates a copied digest against one authoritative model or externally verified asset. Their exact shapes are defined in the universal data model.

A computation recipe selects either one scalar source value or a closed record payload whose fields have exact JSON Pointer bindings. Paths are evaluated over `DigestComputationContext`: `/target` contains the field holder and optional `/verified_input` contains an exact schema-validated external input such as raw file bytes, a package, a model manifest, or generator configuration.

- Bindings are positive and closed; recipes never mean “all fields except”.
- A recipe using `/verified_input` declares its exact input schema. Capture and provenance validation complete before hashing, and the large input need not be duplicated in the target model.
- The target digest field cannot read itself directly or indirectly.
- `direct_value` copies the schema-normalized value at the source path.
- `referenced_digest` resolves the referenced immutable object and copies the digest produced by the named recipe and version.
- Every required payload field has exactly one binding, and no two bindings write one field.
- Payload schema collection semantics supply all ordering and comparator behavior; recipes do not duplicate them.
- The graph formed by `referenced_digest` edges is acyclic. A cycle rejects the registry snapshot before activation.

A model reference locates exactly one immutable source object and requires equality with the digest produced by its named computation recipe. An external-asset reference requires its immutable installation or activation verifier contract. Reference chains terminate at a computation recipe, contain no cycles, and never rehash a copied digest.

Digest equality proves payload equality under one recipe. It never supplies lifecycle identity. Opaque artifact, artifact-version, record, entity, relation, diagnostic, projection, and occurrence identifiers remain governed by their own lifecycle rules. Closed identities never reopen because an equal digest reappears. Content-addressed caches and `ContentBlob` uniqueness may reuse bytes without sharing historical identity.

## Streaming and physical independence

The digest always covers the complete canonical logical value. Definite lengths allow a conforming implementation to stream bytes, text, sequences, and already ordered maps directly into SHA-256. Sets must be ordered first and may use bounded external sorting.

Buffer size, compression, database layout, partitioning, concurrency, and storage references never affect a digest. UCE v1 has no implicit Merkle tree. A future partially verifiable structure requires an explicit versioned tree schema and digest recipe. Full-buffer and streaming encoders must produce byte-identical output.

## Registry and version negotiation

UCE is not selectable per agent query. Each schema version selects exact recipe versions; each recipe pins UCE and its hash algorithm. A snapshot's `registry_snapshot_id` retains the complete immutable set needed to interpret every reachable record, including historical domain, comparator, verifier, runtime-component, recipe, and schema versions. `RegistrySnapshot.core_registry_digest` commits the exact core definitions while namespace bindings commit every complete plugin contribution.

A snapshot may therefore reuse immutable records created under older retained recipes without rewriting them. The engine must retain decoders for every UCE version reachable from retained state. Plugins declare compatible runtime contracts, including required UCE support, and incompatible activation fails before indexing. Supported UCE and algorithm capabilities are discoverable through administrative/schema introspection rather than repeated in ordinary MCP responses.

## Validation and integrity behavior

- Plugins and analyzers submit normalized values; the core computes authoritative digests.
- Producer-supplied transfer or idempotency digests are always recomputed and compared.
- Schema, references, recipe bindings, ownership, and digests are validated before snapshot publication.
- Imported manifests are fully verified before an index becomes queryable. Large blobs may verify incrementally but remain unavailable until successful.
- Suspect values are quarantined and never returned as valid results.
- Corruption is operational state, not a source `DiagnosticRecord`.
- Historical snapshots are never “repaired” from the current filesystem.
- Rebuildable optional projections may be regenerated from retained verified inputs. Missing mandatory structural state makes the snapshot unavailable.

The normative mapping to compatibility, candidate, and public operation errors is defined in [Core canonical encoding errors](core-canonical-encoding-error-codes.md).

## Cross-language conformance

The versioned UCE corpus contains `CanonicalEncodingConformanceCase` values defined in the universal data model. Successful cases pin logical input, schema and recipe versions, expected CBOR bytes, and expected digest. Negative cases pin the exact stable UCE error code.

The corpus covers field permutations, empty and large collections, duplicates, absent versus null, Unicode edge cases, invalid UTF-8, numeric boundaries, decimals, timestamps, raw bytes, streaming, domain separation, recipe cycles, vectors, non-canonical CBOR, and resource limits. Published cases are immutable. New coverage creates a later corpus revision.

An encoder or decoder is conforming only after every applicable case passes. At least TypeScript and one independently implemented language must produce identical bytes and digests before UCE v1 implementation is considered complete. The specification and corpus are normative; no single implementation is.

## References

- [RFC 8949: Concise Binary Object Representation (CBOR)](https://www.rfc-editor.org/rfc/rfc8949)
- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [RFC 6901: JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
- [RFC 4648: Base-N Encodings](https://www.rfc-editor.org/rfc/rfc4648)
