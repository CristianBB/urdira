# JavaScript and TypeScript MVP

Status: **Approved**  
Last updated: 2026-08-21
Depends on: Universal data model and plugin contract

## Decision objective

Define the exact first-language scope and the implementation strategy used to validate Urdira's generic architecture.

## Existing constraints

- JavaScript and TypeScript are the first supported ecosystem.
- The implementation must use the generic plugin contract and cannot add TypeScript assumptions to the core.
- Source ownership, evidence, capabilities, and incremental deltas are mandatory.

## Plugin identity and implementation basis

The first analyzer is one plugin, `urdira:javascript_typescript`, owning namespace `jsts`. It implements the generic plugin contract without privileged core calls. Its package pins one exact TypeScript compiler release and commits the compiler, analyzer, parser, project discoverer, resolver, type, flow, and semantic-preparation bytes into the approved digests.

The contribution supplies the byte-identical shared `javascript` and `typescript` `LanguageDefinition` values from the core taxonomy. JavaScript artifacts, including JSX-enabled source, store `javascript`; TypeScript artifacts, including TSX-enabled source, store `typescript`. `js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `mts`, and `cts` are discovery/file-hint aliases only and never persisted as language IDs.

The TypeScript compiler API is authoritative for binding, module resolution,
symbols, types, overloads, and compiler-compatible control-flow facts. The
approved Rust syntax worker is the exclusive production authority for the
stage-one parse, declarations, containment, syntactic imports and exports,
direct dependency graph, and reverse affected set. Incremental `Program` or
builder APIs may accelerate a later semantic worker request, but worker state
is disposable and never authoritative. The interactive TypeScript language
service is not required for correctness and is used only if its answer is
proven equivalent to the frozen compiler-program inputs.

Structural publication uses three fixed reusable passes: (1) declarations,
containment, syntactic imports, and exports; (2) resolved symbols, references,
calls, inheritance, and implementations; and (3) types, compiler diagnostics,
control/data flow, effects, test relationships, and semantic preparation. The
worker may reuse one immutable program/session; stage three must match a fresh
monolithic analysis in visible records and canonical/projection digests.

Stage 1 is a memory-bounded native syntax frontier. It must not create or
invoke a TypeScript process, construct a project-wide TypeScript `Program` or
`Checker`, decode source again in Node, or run the legacy TypeScript syntax
analyzer. The persistent Rust worker retains content-keyed syntax facts and a
bounded dependency graph. It emits already constructed stage-one record and
dependency rows through per-owner cursor pages; Node validates and stages
those rows without reconstructing them from native entities or retaining
another workspace-sized syntax graph. Typed, resolved, diagnostic, flow, and
semantic-preparation facts remain unavailable until their owning later stage.

Exactly one engine owns each production capability. Rust exclusively performs
stage-one source decoding, parsing, declaration and import extraction, graph
maintenance, affected-set calculation, and stage-one fact construction.
TypeScript may parse internally only as an inseparable prerequisite of the
checker-backed stages two and three; those stages cannot publish or reconstruct
stage-one records. Shadow comparison is test and qualification machinery only
and is absent from the activated production path. Unsupported or malformed
native syntax fails the candidate closed instead of falling back to the legacy
TypeScript syntax implementation. Process, state, reset, and build-identity
rules are defined by [Rust native acceleration](25-rust-native-acceleration.md).

Checker-rendered types do not replace the declaration entities emitted by
Rust. Stage three publishes a distinct `jsts:entity_inferred_type` plus a
`jsts:relation_type_of` edge to the stable stage-one declaration identity.
This preserves exact type information while preventing TypeScript from
serializing a second copy of any stage-one declaration, containment, import,
or export record.

The Rust-authoritative affected scope is mandatory on the checker preparation
call and every owner publication call. It is narrowed to the owner's verified
closure without changing authority or selecting a second analysis key. The
production route retains one checker process and reuses its verified content
hashes for stages two and three, so per-owner publication does not reread or
decode source blobs already consumed while preparing the program.

## Language and artifact scope

The MVP accepts `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts`, and `.d.cts`, plus JSON files consumed by supported module resolution or project configuration. JavaScript uses the project's `allowJs`, `checkJs`, JSDoc, and module-detection rules; when no project config exists, Urdira creates a documented inferred project with conservative defaults derived only from file extensions and nearest package metadata.

Supported syntax must be accepted by both the pinned Oxc stage-one parser and the pinned compiler release, including JSX/TSX, decorators under the selected compiler mode, namespaces, enums, private fields, top-level await, imports, exports, and JSDoc types. Malformed input or syntax outside that intersection fails the candidate closed with a bounded native-worker error. It is never partially parsed or reprocessed by the TypeScript stage-one implementation.

JSON, Markdown, CSS, templates, and other assets remain source artifacts and participate in lexical and generic semantic search. They receive JavaScript/TypeScript canonical semantics only when a registered plugin or later framework enricher contributes them.

## Project discovery

The plugin discovers every `tsconfig.json` and `jsconfig.json` not excluded by source policy, follows `extends` and project references, and returns exact configuration and membership dependencies. It supports composite projects, solution-style references, `rootDirs`, `baseUrl`, `paths`, `typeRoots`, `types`, `include`, `files`, `exclude`, `moduleSuffixes`, and per-project compiler options through the pinned compiler behavior.

Discovery and analysis use only `PluginAnalysisContext`. Reads of configs, package declarations, path-alias targets, project references, ambient/generated declarations, and validated prerequisite records are captured automatically. Directory/config selectors remain lookup dependencies even when empty, so adding a new matching project, declaration, or path target invalidates the correct partition. Consuming an enricher input expands its proven transitive artifact closure; the TypeScript plugin does not duplicate SDK-observed input arrays.

An artifact may belong to several project partitions. Each partition has a stable key derived from its root configuration artifact, normalized project-reference path, and output-affecting compiler-option digest. Results that differ by project context remain distinct plugin facts or relations and identify that partition; the core never assumes one file has one global TypeScript meaning.

Configuration inheritance, referenced projects, package manifests, lockfiles used for dependency identity, and resolution targets are exact reverse dependencies. Changing any of them invalidates the affected partitions. If the compiler cannot prove a narrower affected-project set, the plugin requests full partition reanalysis.

## Modules and packages

ESM and CommonJS are both first-class. Resolution follows the exact selected TypeScript modes, including `node16`, `nodenext`, `bundler`, `node10`, and `classic` when supported by the pinned compiler. File extension, nearest `package.json` `type`, `exports`, `imports`, `main`, `types`, `typesVersions`, path mapping, and declaration substitution are preserved as evidence inputs.

Static `import`, `export ... from`, `import = require`, literal `require`, and literal dynamic `import()` produce confirmed module relations when resolution succeeds. Non-literal `require` or dynamic import produces possible targets when bounded candidates exist and an unresolved relation plus diagnostic otherwise. CommonJS export assignment and property patterns are modeled only when the compiler and registered syntactic rules establish them; runtime monkey-patching is not guessed.

Package workspaces are discovered from npm, pnpm, Yarn, and Bun workspace declarations and supported lockfile formats. Urdira reads manifests and lockfiles but never executes a package manager, install script, runtime loader, or workspace command. Unsupported or malformed lockfile features degrade package-identity enrichment, not source parsing.

## External dependencies and declarations

Workspace source and checked-in declarations are fully indexed. Dependency `.d.ts` files selected by module resolution are represented as exact external or virtual artifacts and provide symbols, types, inheritance, signatures, and module relations. Their implementation bodies are absent by definition and completeness reflects only capabilities that require them.

By default, implementation source under dependency/vendor roots is not deeply analyzed. Urdira indexes the resolved public declaration surface, package identity, and exact files needed by resolution. A workspace policy may include dependency source explicitly, at which point it is analyzed as ordinary source under separate artifact ownership.

TypeScript standard libraries and configured ambient type libraries are versioned virtual artifacts keyed by compiler package digest and exact library content. They are queryable when explicitly requested but excluded from ordinary workspace result ranking unless a relation requires them for context.

## Canonical outputs and precision

The MVP emits entities for modules, namespaces, classes, interfaces, type aliases, enums, functions, methods, accessors, constructors, variables, parameters, properties, imports, exports, call sites, operations, and relevant type/value expressions. It emits containment, declaration/reference, import/export, alias, call, construct, inheritance, implementation, override, type-use, read, write, return, throw, await, and test relations when supported by evidence.

Capability precision is:

- syntax and declarations: `syntactic`, complete for accepted files;
- symbol and module resolution: `resolved`, subject to explicit unresolved diagnostics;
- type information, overload selection, inheritance, implementation, and override: `typed`;
- call relationships: `typed` for direct calls, selected overloads, constructors, methods with compiler-resolved targets, and statically bounded unions; `modeled` or `heuristic` only for separately classified candidates;
- control flow: `flow_sensitive`, intraprocedural per callable using compiler-compatible branch, loop, exception, return, await, and narrowing regions;
- data flow: `flow_sensitive`, intraprocedural def-use for parameters, locals, properties with statically identified receivers, returns, and thrown values;
- effects: deterministic summaries from supported reads, writes, calls, throws, awaits, and modeled APIs; and
- semantic preparation: `syntactic` plus already validated symbol and relationship context.

The MVP does not claim complete general interprocedural value flow, heap alias analysis, reflection, prototype mutation, `eval`, generated runtime code, arbitrary proxy behavior, or runtime dependency injection. Interprocedural summaries are emitted only for registered deterministic rules and carry their assumptions.

## Calls and dynamic behavior

A direct compiler-resolved target is confirmed. Overloads retain the selected signature and implementation relation. Union or interface dispatch emits every statically valid candidate with its own evidence; a target is confirmed only when the program semantics establish it uniquely. Class virtual dispatch may produce possible implementation candidates while retaining the confirmed call-to-declared-contract relation.

Property calls with unknown receiver type, computed property names, non-literal dynamic imports, callbacks escaping to unknown code, reflection, decorators with runtime replacement semantics, proxies, and framework containers produce unresolved or ambiguous targets and registered diagnostics. They never disappear from the model and never become arbitrary confirmed edges.

Candidate sets are bounded by exact program symbols and scope. If a complete bounded set cannot be established, Urdira stores the symbolic observation without claiming exhaustive candidates. This distinction feeds change-impact completeness directly.

## Framework and test semantics

No framework-specific behavior is built into the core or mandatory MVP plugin. The base plugin recognizes language-level test structure only through generic imports, calls, declarations, and naming facts; it does not declare a function a route, component, controller, or test merely from an unversioned heuristic.

The initial distribution may include optional bridge/enricher plugins for Node test APIs, Vitest, Jest, and common package-entry conventions after they pass the generic plugin conformance contract. Each remains independently activatable, additive, namespaced, versioned, and failure-isolated. Express, Nest, React, Next, and other application frameworks are explicitly post-MVP enrichers rather than hidden base-analyzer behavior.

## Verification matrix

The fixture matrix covers every supported extension; ESM, CommonJS, and mixed packages; all supported module-resolution modes; JSX/TSX; JSDoc JavaScript; project references; overlapping configs; npm, pnpm, Yarn, and Bun workspaces; path aliases; dependency declarations; ambient types; symlinks under policy; unresolved modules; overloads; generics; unions; inheritance; decorators; dynamic dispatch; branch switches; deletion and identical reappearance; empty lookup followed by matching addition; selector membership change; staged prerequisite reads; consumed-record dependency changes; cancellation; every budget dimension; concurrent context reads; and incremental equivalence.

The compatibility corpus contains:

- synthetic single-feature fixtures with exact expected records, evidence, diagnostics, dependencies, and completeness;
- small real packages for each module and workspace layout;
- at least three medium open-source TypeScript codebases using different build/test stacks; and
- one monorepo with project references and at least 100,000 source lines.

Every supported TypeScript compiler minor line declared by the plugin is tested separately. The first release supports exactly one bundled compiler line; adding another creates another plugin release and analysis digest. Full and incremental indexing of the same final source state must produce identical visible canonical and projection set digests.

## Completion criteria

The MVP scope explicitly identifies supported and unsupported behavior. Acceptance additionally requires running the same core conformance suite with the Rust-shaped contract fixture from the plugin specification, proving that no JavaScript/TypeScript branch entered the core.
