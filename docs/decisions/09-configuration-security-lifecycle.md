# Configuration, Security, and Lifecycle

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Workspace, storage, and semantic-search specifications

## Decision objective

Define repository boundaries, exclusions, local-data handling, symlink behavior, configuration precedence, cache lifecycle, and safe operational defaults.

## Existing constraints

- Urdira's public interface is read-only.
- Source code remains local by default.
- Urdira does not expose arbitrary command execution.
- Workspace selection is explicit in every source query.
- Snippets and semantic indexes may contain sensitive source content.
- Plugin installation and activation are administrative local operations outside the read-only agent MCP surface.
- Upgrade, downgrade, and explicit rollback use the same candidate plan and atomic publication pipeline; failure preserves the previous published tuple.
- Plugin resolution uses only explicitly available local packages and never performs implicit network downloads.
- Embedding profiles and every vector-producing asset or runtime are core-owned. Additional models are installed as integrity-verified data-only Urdira model packs, never as language-plugin payloads, and model-pack selection is versioned workspace configuration. A pack contains no executable code in any form and may only reference embedding runtime components already shipped with the exact Urdira engine version. Installation performs parsing, integrity and compatibility validation, and local asset persistence; it never invokes pack-provided commands or callbacks.
- A logical model pack is one deterministic canonical manifest plus its complete content-addressed asset set. The manifest commits to every asset's digest, exact decoded byte length, media type, and semantic role. Every declared asset is mandatory for that pack identity. Asset bytes are stored once in Urdira's local content-addressed store and may be shared by multiple installed packs without changing either pack identity.
- Offline and online installation are delivery variants of the same logical pack. An offline bundle carries the canonical manifest and every required blob. An explicitly requested online installation obtains the same digest-addressed blobs from non-authoritative delivery locators held outside the canonical manifest. URLs, mirror order, credentials, headers, archive layout, compression, and transport metadata never participate in pack or asset identity.
- Installation publishes a pack atomically only after the manifest, every required blob, all byte lengths and digests, every profile reference, and all engine-component compatibility requirements validate locally. A failed or cancelled installation leaves no active partial pack; unreferenced temporary blobs are later eligible for cache cleanup.
- Indexing, embedding generation, semantic querying, pagination, and retained execution replay never access the network or lazily fetch a missing asset. A missing or corrupt local blob makes the affected pack or profile unavailable until an explicit administrative repair succeeds.
- Model packs have no signatures, signing keys, trust store, certificate chain, publisher authority, or authenticated provenance protocol. Installation authorization is the administrator's explicit local action over one exact manifest digest. Manifest and asset digests prove byte identity and detect corruption or substitution relative to that approved digest; they do not prove who created, published, reviewed, or endorsed the content. Declared publisher, provenance, license, evaluation, and source-location metadata are integrity-covered statements but are not independently authenticated by Urdira.
- Reusing one `model_pack_id + model_pack_version` with a different canonical manifest digest is a hard installation collision. Urdira never chooses between those candidates by URL, catalog, claimed publisher, recency, or installation order and never overwrites an installed identity implicitly.
- A model pack is addressed by `model_pack_id + model_pack_version + manifest_digest`. The ID is a stable canonical namespaced identifier, the version is normalized SemVer 2.0.0, and the digest covers the complete canonical manifest except its own field. Reinstalling the exact triple is idempotent. Any canonical manifest change requires another version; identical bytes under different ID/version coordinates remain distinct logical packs even though their blobs may be deduplicated.
- Every model-pack manifest embeds at least one complete `EmbeddingProfile` definition in a duplicate-free set canonically ordered by `embedding_profile_id`. Profile definitions are never deferred to an asset or delivery locator. Installation recomputes each `profile_digest` and validates all referenced assets and engine requirements before publication. Identical profile IDs from several packs are deduplicated only when the profile definitions, all four runtime requirements, and both runtime-configuration envelopes are identical, with reference accounting; any difference under the same profile ID rejects activation atomically.
- Model assets use `ModelPackAssetEntry`: `content_digest` is the sole blob identity, while exact decoded length, canonical media type, and a closed semantic role are validated manifest metadata. No asset ID, filename, logical path, archive member, URL, or local CAS path participates in identity. Declarative model and tokenizer manifests reference subordinate same-pack blobs by digest; missing, cyclic, path-based, or cross-pack references reject installation.
- `ModelPackRuntimeRequirement` closes portable behavioral compatibility: every embedded profile has exactly one document renderer, query renderer, segmenter, and generator requirement, each pinned to a platform-neutral core component ID, behavior release, behavior digest, and the profile's contract version. Packs never name binary builds. Workspace activation resolves and pins exact compatible local build and implementation digests; missing builds reject only that activation without affecting installed packs or existing configurations.
- Every embedded profile has exactly one segmenter and one generator `ModelPackRuntimeConfiguration` asset. Each canonical envelope is closed, bound to the matching runtime requirement, validated against the exact closed schema pinned by that core component contract, and digested over the complete envelope plus typed configuration. The segmenter digest equals the profile contract; the generator digest is pinned by vectors, materializations, and query execution. Environment, path, network, arbitrary flag, hardware-probed, platform-dependent, and adaptive values are forbidden.
- Pack coordinates are permanently reserved locally by `model_pack_id + model_pack_version`, even after removal, so another manifest digest can never reinterpret a previously accepted version. An installed occurrence and each installation-to-profile supply have monotonic release fields and are never reopened; reinstalling removed identical content creates new occurrences under the same reservation.
- Installation derives one permanent portable binding per profile from its definition, four behavior requirements, two runtime configurations, and complete operational asset closure. Exact portable bindings deduplicate across packs; any difference under one profile ID is a collision. A profile is eligible for new configuration only while an active supply exists and compatible local builds resolve; retained configurations and materializations continue to pin their exact executable binding after the last supply is removed.
- Active installations root every declared asset. Retained executable bindings root only assets required for rendering, segmentation, generation, and querying plus their exact local runtime builds, allowing metadata-only license, provenance, and evaluation blobs to become collectible after removal. Logical removal never directly deletes bytes; the global reachability collector remains the sole deletion authority.
- Installation and repair stage temporary content outside published state. Pack publication atomically creates the reservation when new, installation occurrence, supplies, portable bindings, and asset roots only after complete validation. Workspace activation separately publishes an executable binding after resolving all four builds. Failure and cancellation publish no partial state. Repair restores exact missing bytes without changing logical identity; corruption produces explicit unavailability and never fallback.
- The same canonical model pack is portable across operating systems and CPU architectures. Local builds are distributed with Urdira, verified separately, and excluded from pack identity. Existing materializations pin their exact build digests; moving them to a host without those builds requires semantic rebuilding under a newly resolved executable binding rather than relabeling vectors.
- Input templates are direct strict UTF-8 `text/plain` assets. Their fixed bytes are verified independently by storage and template digest domains, and their renderer contracts expose a closed placeholder vocabulary. Includes, paths, environment variables, URLs, code, commands, callbacks, clocks, randomness, network state, and plugin execution are forbidden template inputs.

## Configuration domains and precedence

Configuration is split so repository content cannot grant itself executable or data-access authority:

- **installation policy** controls storage roots, network, executable packages, model packs, allowed external roots, sandbox strength, resource ceilings, retention maxima, and administrative permissions;
- **user policy** controls ordinary defaults such as response budgets, local retention within installation bounds, logging verbosity, and default ignore behavior;
- **workspace policy** controls inclusion patterns, language/plugin selection from already approved local packages, analysis options, semantic-profile selection from already installed packs, and query defaults; and
- **request options** control only the explicitly documented read, freshness, completeness, snippet, evidence, diagnostic, and response-budget choices.

Precedence is request, persisted workspace override, workspace file, user file, installation file, then built-in defaults. A higher layer may narrow authority but cannot exceed installation policy. In particular, workspace files cannot install or approve packages, enable network access, weaken sandboxing, add an outside root, expose secret-classified snippets, raise hard resource limits, or shorten mandatory recovery retention.

The portable workspace file is `.urdira/config.json`; it is optional, strict UTF-8 JSON, and uses one explicit schema version. User and installation file locations follow the platform directory conventions documented by the package, while persisted administrative overrides live in the catalog. Configuration never depends on current directory. Unknown fields, duplicate JSON keys, invalid Unicode, and unsupported schema versions reject that layer with an exact configuration issue; they are never ignored.

Environment variables may select the Urdira data root and administrative config location before startup. A private daemon endpoint is derived and managed by the engine and is not configurable by agents or plugins. Environment variables cannot carry output-affecting analyzer, embedding, ranking, ignore, retention, or security values. Every active workspace stores a normalized `configuration_revision_id` and digest committing to the effective non-secret values. Secret references contribute stable secret-version identifiers, never secret bytes.

The exact immutable control record is `WorkspaceConfigurationRevision` in the universal data model. It preserves the normalized effective Schema-IR value, contributing layer digests, analysis and query subset digests, resolved embedding bindings, ancestry, cause, and complete revision digest without storing secret bytes.

Changing output-affecting workspace configuration creates a candidate generation. Query-only defaults create a control revision without reindexing. Installation-policy changes that invalidate an active configuration leave the last valid snapshot readable, mark the workspace degraded, and require an explicit compliant replacement configuration.

## Inclusion and exclusion policy

Source selection is evaluated in this order:

1. the canonical workspace boundary and allowed external roots;
2. mandatory security exclusions;
3. explicit administrator exclusions;
4. workspace `exclude` and `include` rules, with the last matching explicit rule winning inside an allowed boundary;
5. optional VCS-ignore rules; and
6. generated, vendor, binary, size, and language defaults.

An explicit include may override generated/vendor/VCS defaults but never boundary or mandatory security exclusions. Rules use normalized workspace-relative `/`-separated paths, a versioned gitignore-compatible glob subset, and case behavior from the source provider. Every artifact observation records the effective inclusion state and registered reason.

`.gitignore` is honored by default for discovery noise but files already required as exact project configuration, module-resolution input, declaration surface, or dependency metadata may be retained as non-primary analysis inputs. `.git/info/exclude` and global Git excludes are used only when explicitly enabled because they are machine-local and otherwise make workspace results surprising.

Default deep-analysis exclusions include VCS metadata, Urdira storage, package caches, dependency implementation roots, build outputs, coverage output, minified bundles, generated source maps, binary objects, archives, and files above 10 MiB. Lockfiles, manifests, declaration files, and generated type surfaces remain eligible for their required structural roles while being excluded from ordinary semantic documents unless explicitly included.

Binary classification uses NUL/content validation plus media and extension rules. A plugin cannot override a core exclusion; it may only request already observed eligible inputs. Generated detection uses explicit rules, compiler outputs, manifest metadata, source-map markers, and registered plugin facts. Uncertain generated status is reported and does not silently exclude source.

## Symlinks and external paths

The default provider records a symlink artifact but follows it only when its fully resolved target remains inside the canonical workspace root. Internal targets are deduplicated by provider file identity while every logical source path remains queryable. Cycles are diagnosed and not followed.

Targets outside the root are excluded by default even when a repository configuration requests them. An administrator may grant a normalized external root to an exact workspace; the provider then watches and versions it as a virtual external artifact with its canonical URI, while the workspace-relative symlink remains its referring source. Relative traversal, symlink replacement, mount changes, and case changes are revalidated on every open to prevent time-of-check/time-of-use escape.

Device files, sockets, pipes, procfs-like trees, and network filesystems without a provider stability contract are never read as ordinary artifacts. Hard-linked files share physical reads where safe but retain distinct artifact addresses.

## Sensitive content and snippets

Mandatory default sensitive patterns cover private-key formats, credential stores, authentication tokens, `.env` variants containing assignments, cloud credential directories, package-manager auth files, and files explicitly marked secret by installation policy. Secret classification combines path/media rules with bounded content detectors. Detection records only rule codes and spans; secret values are never logged or inserted into diagnostics.

By default a secret-classified artifact is catalogued by path and digest but its raw bytes are not supplied to language plugins, semantic document generation, lexical content indexes, or MCP snippets. Queries may report that relevant content was excluded and therefore completeness is partial. An administrator may opt an exact path pattern into structural indexing, but snippet and semantic exposure remain separately disabled unless explicitly granted.

When snippet redaction is enabled for otherwise indexable text, Urdira replaces detected sensitive spans with a fixed marker and returns redaction spans and `truncated`/redacted metadata in the source view. Redacted snippets are never described as exact source bytes. Structural coordinates continue to refer to the pinned original artifact version. A request cannot disable a stronger workspace or installation redaction policy.

MCP responses never expose absolute host paths, CAS locations, package roots, credentials, environment values, raw model configuration secrets, or plugin scratch paths. Physical artifacts use normalized workspace-relative paths; external and virtual artifacts use canonical safe URIs.

## Local storage, permissions, and encryption

By default all mutable state lives under the platform's per-user application-data and cache directories in a Urdira-owned directory with owner-only access. Directories are created with mode `0700` and files with `0600` on POSIX; Windows ACLs grant only the owning account and system administrators. Startup rejects a storage root writable by untrusted principals unless an administrator explicitly acknowledges the risk.

Installation catalog, workspace databases, source CAS, query manifests, model assets, backups, plugin packages, scratch space, and logs have separate subdirectories and quotas. Temporary files are created in the destination filesystem with unpredictable names and are atomically installed or removed. Cleanup never follows symlinks and validates every target beneath its configured root.

The initial release provides no bespoke application-level database or CAS encryption. At-rest confidentiality relies on operating-system full-disk or encrypted-volume facilities, which preserve deterministic content addressing and crash recovery without introducing an unreviewed key system. Urdira reports whether its storage root is known to be protected when the platform exposes that information but never claims secure encryption it cannot verify. Transport is local authenticated IPC as defined by the daemon specification.

## Network and model-pack installation

Indexing, plugins, query execution, embeddings, pagination, startup, repair verification, and retained replay perform no network access. The only network-capable core action is an explicit administrative model-pack download. Plugin installation uses an explicit local package or offline bundle in the initial release and never resolves dependencies online.

Online model-pack installation accepts an exact authorized manifest digest plus explicit HTTPS locators for the manifest and missing blobs. `file` locators are allowed for offline administration; plain HTTP, arbitrary schemes, embedded credentials, cross-origin credential forwarding, and repository-relative URLs are rejected. Redirects are disabled by default and, when enabled by installation policy, are limited to HTTPS, five hops, and no credential forwarding across origins.

Proxy use is explicit installation policy. Credentials come from an interactive administrative input or operating-system credential store, remain outside canonical manifests and logs, and are not persisted by Urdira unless the administrator selects a platform credential reference. Downloads have byte, time, concurrency, decompression-ratio, and total-pack limits; stream verification occurs before parsing assets. Cancellation closes connections, deletes staged partial files, and publishes nothing.

Delivery metadata is non-authoritative. A downloaded object is accepted only under the exact administrator-approved digest and manifest closure. Repair retrieves only bytes already named by an installed identity and cannot change any coordinate or definition.

## Plugin authorization and isolation

Plugins contain executable code and therefore require explicit local administrator approval of exact package digest, plugin ID, version, namespace, executable closure, and requested protocol capabilities. Urdira defines no package signing authority or key infrastructure. Digests establish the approved bytes, not publisher identity. Updating to different bytes always requires another approval and activation transaction.

Discovery never executes code. Activation verifies namespace ownership, shared-language supply equality, and the complete closed contribution before starting a worker. Runtime isolation follows the plugin contract: separate supervised processes, no ambient filesystem, environment, credential, shell, or network access, one snapshot-pinned read-only `PluginAnalysisContext`, automatically recorded item/lookup dependencies, private quota-limited scratch, bounded responses, and workspace-local quarantine after repeated failure.

On platforms lacking one defense-in-depth sandbox primitive, Urdira reports the effective isolation level before administrative activation. The protocol's capability deprivation remains mandatory; a build that cannot prevent ambient workspace reads or arbitrary child-process execution is unsupported rather than silently weakened.

## Logging and diagnostics

Default logs contain event time, stable operation or issue code, randomized request/execution/candidate IDs, workspace ID, generation, durations, counts, and resource measurements. They omit source text, query text, snippets, symbol names, artifact paths, canonical payloads, environment values, credentials, model inputs, vectors, and plugin output bodies.

Relative artifact paths and bounded safe plugin messages appear only in an explicitly enabled diagnostic log level and are redacted by the same sensitive-content policy. Raw source logging is not supported. Plugin stdout/stderr is captured into a bounded private ring, sanitized, and exposed only as an opaque failure ID plus registered issue; it is never forwarded to agents.

Default log retention is seven days or 100 MiB, whichever boundary is reached first. Audit records for administrative approvals, activation, removal, migration, emergency eviction, and destructive cleanup contain identities and digests but no source and are retained for 90 days by default. Metrics are local and disabled from network export unless separately configured by the administrator.

## Removal and data deletion

Removing a workspace immediately stops providers, rejects new queries, expires its query executions, releases active configuration and model roots, and marks all workspace snapshots for collection. Default removal is recoverable for 24 hours through a control-plane removal record and retained storage root. `purge` skips that grace period after explicit confirmation of the exact workspace ID.

Physical deletion still uses the global reachability collector so shared blobs and model assets survive while another root needs them. Urdira reports logical removal, pending collection, and verified absence separately. Backups are independent roots and are listed to the administrator; workspace purge cannot pretend to erase them.

Best-effort overwrite is not offered as secure erasure because SSD wear leveling, copy-on-write filesystems, snapshots, journals, and backups can retain bytes. Strong deletion requires destruction of an externally managed encrypted volume or its key. Urdira documents this limitation and can verify only that its named live paths and catalog references no longer exist.

## Administrative operations

Plugin install/activate/upgrade/downgrade/rollback/remove, model-pack install/repair/remove, workspace register/relocate/suspend/remove/purge, migration, backup/restore, retention pins, and emergency cache eviction are administrative operations outside MCP. Every request identifies exact targets and shows a dry-run plan before a destructive or executable-state transition.

Long operations persist an operation identity, state, exact authorized input digests, progress counters, cancellation state, staged objects, and issues. Cancellation is safe at documented barriers and never rolls back an already committed snapshot or installation; it stops future phases and cleans unreachable staging through GC.

Persisted logical operation identities and staged file paths are not physical
path components. Filesystem staging maps both deterministically to separate
digest-derived portable entry names, preventing path traversal,
reserved-character failures, and disclosure of logical identifiers through
directory or file names. The catalog retains the complete logical paths.

Plugin changes use the approved candidate pipeline. Model-pack changes use their approved atomic installation transaction. Migration uses shadow-copy verification. Failures preserve the old active state. Administrative retries are idempotent only when the exact request and input digests match; another request creates a new occurrence.

Retention-policy decreases, workspace purge, package removal, and model-pack removal release roots but do not directly delete shared bytes. Cleanup reports what became collectible and what remains retained, including the exact root reasons.

## Security verification

Release tests cover malicious repository configuration, path traversal, symlink races, archive bombs, digest mismatch, model-manifest cycles, unsafe redirects, credential leakage, plugin escape attempts, worker fork/network attempts, malformed output, secret detectors, snippet redaction, log minimization, local IPC permissions, cross-user access, cancellation, removal, and shared-blob retention.

## Completion criteria

The defaults prevent accidental scope expansion or data disclosure while preserving predictable local indexing behavior. Implementation acceptance requires the security verification suite above on every supported platform.
