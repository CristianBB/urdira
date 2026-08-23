# Urdira v3 logical values and digests

Status: Current logical-digest summary; governed by [Decision 21](../decisions/21-native-pipeline-relational-storage.md) and [Decision 22](../decisions/22-v3-optimization.md)

Urdira v3 has no universal persistence or transport encoding. The indexing hot
path uses native streams, transferable `ArrayBuffer` ownership, typed arenas,
and relational SQLite rows. Source content is stored as immutable CAS bytes.

Logical digests are calculated incrementally from schema-owned fields. Each
field contributes its stable identifier, explicit presence marker, logical type
tag, length where applicable, and value. Sequences retain declared order and
sets use the owning schema comparator. These rules are implemented by the
logical digest writer and do not hash Protobuf or JSON bytes.

`Uint8Array` is the only in-process byte value. JSON/MCP never projects bytes
as a string. It returns UTF-8 text or an opaque `{digest, byte_length,
media_type}` reference. Protobuf-ES is reserved for an explicitly configured
cross-process provider, sandboxed plugin, or portable import/export boundary;
it is not persisted and does not define identity, ordering, or a digest.

The old universal encoding corpus and its encoded-byte fixtures are absent from
the v3 runtime. A pre-v3 or early-preview v3 data root is not decoded or
migrated. Inventory and backup are external administrative actions; activation
requires a fresh v3 root and source reindexing. CAS objects remain reusable only
after complete digest, length, and workspace-scope verification.
