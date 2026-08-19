# Core Taxonomy

Status: **Approved initial registry**  
Last updated: 2026-08-08  
Depends on: [Universal data model](../decisions/01-universal-data-model.md)

## Registry purpose

This file is the authoritative initial registry for Urdira's languages, capability contracts, construct classes, universal kinds, core facets, semantic roles, and effects. It defines the language-agnostic semantics on which public operations may depend.

A plugin preserves language precision through its concrete namespaced kind while mapping every record to exactly one base kind in this registry. Universal bases are deliberately small. Facets describe only intrinsic boolean structure. Evidence-backed architectural classifications use facts rather than facets.

For compactness, table cells listing core facets, kinds, or registry values may omit the `core:` prefix. Every serialized and public API value remains fully namespaced.

Every definition in this initial registry has `definition_revision: 1`, `schema_version: 1`, and `lifecycle_state: active`; lifecycle transition and replacement fields are omitted. Core definitions omit `plugin_owner`. Facet `implied_facets`, semantic-role `implied_roles`, effect `implied_effects`, and incompatibility sets are empty unless a table explicitly states otherwise.

Unless a fact-kind table below declares required payload fields, the initial core kind payload schema is a closed empty object. Producers that need language- or framework-specific payload fields register a concrete plugin kind mapped to the core base. `core:diagnostic` is the deliberate exception: its payload schema is selected by the registered `diagnostic_code` definition.

## Initial language registry

| Language ID | Display name | Aliases | Exact meaning |
|---|---|---|---|
| `javascript` | JavaScript | `js`, `jsx`, `mjs`, `cjs` | ECMAScript source and declaration semantics, including JSX syntax when the selected artifact/project configuration enables it. |
| `typescript` | TypeScript | `ts`, `tsx`, `mts`, `cts` | TypeScript source and declaration semantics, including TSX syntax when the selected artifact/project configuration enables it. |

These shared definitions have no `plugin_owner`. Aliases are discovery terms and file-extension hints only; stored language references use the canonical IDs. The JavaScript/TypeScript plugin supplies the exact definitions above. Another analyzer may supply them only byte-identically; a conflicting definition rejects activation.

## Initial capability contract registry

Every capability below has `capability_contract_version: 1.0.0`. `C` means confirmed claims are allowed; `P` means possible claims are allowed. Partition schemas are closed core Schema IR coordinates. Evidence names are the exact core `EvidenceRecord.basis` values. `standard` completeness means authoritative replacement is required for `complete`; `partial`, `unknown`, and `unsupported` are allowed; every non-complete state requires a registered reason; affected scope is exact when enumerable. Every source-analysis row requires `owner_artifact`; `direct`, `record`, `reference`, `resolution`, and `evidence` mean the corresponding `CapabilityDependencyObligation` and use `plugin_partition` fallback unless the row states `workspace`. The core-only semantic-retrieval row is materialization-owned and uses the semantic coverage contract instead.

| Capability | Allowed precision | Categories | Allowed universal outputs | Evidence bases | Claims | Partition schema | Additional dependency obligations | Completeness |
|---|---|---|---|---|---|---|---|---|
| `core:syntax_structure` | syntactic | entity, relation, evidence, diagnostic | all core entity kinds; `contains`, `defines`, `import`, `export` | syntax | C,P | `core:ArtifactPartitionKey@1` | direct | standard |
| `core:symbol_declarations` | syntactic, resolved | entity, relation, evidence, diagnostic | all core entity kinds; `contains`, `defines`, `aliases` | syntax, symbol_resolution | C,P | `core:ProjectPartitionKey@1` | direct, resolution | standard |
| `core:symbol_resolution` | resolved, typed, modeled, heuristic | relation, evidence, diagnostic | `aliases`, `type_of`, `references`, `call`, `read`, `write`, `import`, `export`, `inherits`, `implements`, `overrides`, `captures`, `depends_on`, `binds` | symbol_resolution, type_analysis, framework_model, heuristic | C,P | `core:ProjectPartitionKey@1` | direct, record, reference, resolution | standard |
| `core:type_information` | typed, flow_sensitive, modeled | entity, relation, fact, evidence, diagnostic | `type`, `value`, `operation`, `type_of`, `implements`, `binds_argument`, `constant_value`, `assertion` | type_analysis, control_flow, data_flow, framework_model | C,P | `core:ProjectPartitionKey@1` | direct, record, reference, resolution | standard |
| `core:module_dependencies` | syntactic, resolved, modeled | entity, relation, evidence, diagnostic | `container`, `import`, `export`, `depends_on` | syntax, symbol_resolution, configuration, framework_model | C,P | `core:ProjectPartitionKey@1` | direct, record, reference, resolution | standard |
| `core:call_relationships` | resolved, typed, flow_sensitive, modeled, heuristic | entity, relation, evidence, diagnostic | `callable`, `operation`, `call`, `binds_argument`, `captures` | symbol_resolution, type_analysis, control_flow, framework_model, heuristic | C,P | `core:CallablePartitionKey@1` | direct, record, reference, resolution | standard |
| `core:inheritance_and_implementation` | resolved, typed, modeled | relation, evidence, diagnostic | `inherits`, `implements`, `overrides` | symbol_resolution, type_analysis, framework_model | C,P | `core:ProjectPartitionKey@1` | direct, record, reference, resolution | standard |
| `core:control_flow` | flow_sensitive, modeled, heuristic | entity, relation, fact, evidence, diagnostic | `operation`, `control_flow`, `returns`, `throws`, `handles`, `reachability` | control_flow, framework_model, heuristic | C,P | `core:CallablePartitionKey@1` | direct, record, reference | standard |
| `core:data_flow` | flow_sensitive, modeled, heuristic | entity, relation, fact, evidence, diagnostic | `value`, `operation`, `read`, `write`, `data_flow`, `binds_argument`, `constant_value`, `assertion` | data_flow, control_flow, type_analysis, framework_model, heuristic | C,P | `core:CallablePartitionKey@1` | direct, record, reference | standard |
| `core:effects` | typed, flow_sensitive, modeled, heuristic | fact, evidence, diagnostic | `effect` | type_analysis, control_flow, data_flow, framework_model, heuristic | C,P | `core:CallablePartitionKey@1` | direct, record, evidence | standard |
| `core:test_relationships` | resolved, typed, modeled, heuristic | entity, relation, fact, evidence, diagnostic | `container`, `callable`, `resource`, `covers`, `semantic_role` | symbol_resolution, type_analysis, framework_model, configuration, heuristic | C,P | `core:ProjectPartitionKey@1` | direct, record, reference, evidence | standard |
| `core:framework_semantics` | resolved, typed, modeled, heuristic | entity, relation, fact, evidence, diagnostic | every core universal kind declared in this registry revision | syntax, symbol_resolution, type_analysis, framework_model, configuration, heuristic | C,P | `core:FrameworkPartitionKey@1` | direct, record, reference, resolution, evidence; workspace fallback permitted | standard |
| `core:semantic_preparation` | syntactic, resolved, typed, modeled | evidence, diagnostic | `evidence`, `diagnostic` plus registered derived semantic projections | syntax, symbol_resolution, type_analysis, framework_model, configuration | C,P | `core:ArtifactPartitionKey@1` | direct, record, evidence | standard |
| `core:semantic_retrieval` | modeled, heuristic | — | — | semantic_similarity, heuristic | P | `core:ArtifactPartitionKey@1` | record, evidence | semantic coverage |

“All core entity kinds” and “every core universal kind” are the exact sets declared by the corresponding tables in this registry revision; neither includes later plugin kinds or a callback. Plugin concrete kinds remain limited further by their own mappings. Heuristic derivation can emit only possible claims; confirmed claims require a non-heuristic evidence chain allowed by the same row. `record` obligations always require transitive artifact closure. The em dash in the semantic row means both allowed-record sets are empty: semantic candidates and projections are derived query/index values rather than canonical claims. `core:semantic_retrieval` is supplied only by the core semantic materialization/query engine, cannot appear in a language-plugin offered-capability set, and uses the pending/excluded/unsupported/failed coverage reasons in the semantic registry.

## Initial construct and limitation registries

| Construct code | Exact applicable capabilities | Exact meaning |
|---|---|---|
| `core:dynamic_import` | module_dependencies, symbol_resolution, call_relationships | A module or callable target is selected from a runtime-computed import specifier. |
| `core:computed_property` | syntax_structure, symbol_declarations, symbol_resolution, type_information, call_relationships | A declaration or access key is computed rather than represented by one statically fixed name. |
| `core:runtime_dispatch` | symbol_resolution, call_relationships, control_flow, data_flow, effects | Runtime values or dispatch rules select among targets beyond the producer's proved closed candidate set. |
| `core:generated_declaration` | syntax_structure, symbol_declarations, symbol_resolution, type_information, module_dependencies | A declaration is produced by a generator or compiler transform rather than the directly indexed source text. |
| `core:external_declaration` | symbol_resolution, type_information, module_dependencies, call_relationships, inheritance_and_implementation | Required declaration semantics live outside ordinary workspace source. |
| `core:macro_expansion` | syntax_structure, symbol_declarations, symbol_resolution, type_information, call_relationships, control_flow, data_flow | Expansion changes indexed semantics beyond the literal source form. |
| `core:reflection` | symbol_resolution, call_relationships, data_flow, effects, framework_semantics | Runtime introspection or metadata selects declarations, members, or behavior. |
| `core:eval_like_execution` | syntax_structure, symbol_resolution, call_relationships, control_flow, data_flow, effects | Runtime-provided text or equivalent data is executed as code. |

Capability names in this table are the `core:*` identities from the capability table. Every `applicable_capabilities` entry is an exact `CapabilityRequirement` for version `1.0.0`. Plugins may define narrower namespaced construct classes but cannot broaden these definitions.

| Limitation code | Allowed capabilities | Allowed statuses | Exact trigger and agent guidance |
|---|---|---|---|
| `core:unsupported_construct` | all 13 source-analysis capabilities | partial, unsupported | The selected producer explicitly does not implement one registered applicable construct. Inspect the cited construct and do not assume omitted knowledge. |
| `core:ambiguous_resolution` | symbol_resolution, type_information, module_dependencies, call_relationships, inheritance_and_implementation, framework_semantics | partial, unknown | Resolution retains several legal candidates and cannot prove one exact target. Inspect possible targets and evidence. |
| `core:external_input_unavailable` | all source-analysis capabilities except syntax_structure over self-contained source | partial, unknown, unsupported | A required external declaration, configuration, or virtual source cannot be obtained under the active provider policy. Restore it or accept reported incompleteness. |
| `core:analysis_budget_exhausted` | all 13 source-analysis capabilities | partial, unknown | A declared bounded analysis budget prevents complete evaluation while preserving a sound subset. Narrow scope or raise the configured budget. |
| `core:generated_source_unavailable` | syntax_structure, symbol_declarations, symbol_resolution, type_information, module_dependencies, call_relationships, inheritance_and_implementation, framework_semantics | partial, unknown, unsupported | Required generated declarations or source maps are unavailable. Generate or expose the cited artifact. |
| `core:framework_model_missing` | call_relationships, effects, test_relationships, framework_semantics, semantic_preparation | partial, unknown, unsupported | Source uses framework behavior for which no active exact model exists. Activate an appropriate enricher or retain the limitation. |

“All 13 source-analysis capabilities” and its stated exclusion mean every preceding row except the core-only `core:semantic_retrieval`; semantic materialization gaps use the semantic reason registry. These codes cannot be used as free-text catch-alls: the corresponding construct, artifact, capability state, and diagnostic scope required by the code must be present.

## Universal entity kinds

| Universal kind | Exact meaning | Allowed core facets |
|---|---|---|
| `core:container` | A semantic unit whose primary purpose is grouping or organizing entities, such as a package, module, or namespace. A physical file remains a `SourceArtifact`, not an entity of this kind merely because it contains text. | `declaration`, `definition`, `scope`, `member`, `member_container`, `synthetic`, `implicit`, `generated`, `external` |
| `core:type` | A type-level abstraction or classifier, including classes, interfaces, structs, enums, traits, protocols, and type aliases. | `declaration`, `definition`, `scope`, `member`, `member_container`, `type_parameter`, `constructible`, `abstract`, `synthetic`, `implicit`, `generated`, `external` |
| `core:callable` | A semantic unit that can be invoked, including functions, methods, constructors, lambdas, and operators. A type that can be constructed remains `core:type` with `core:constructible`. | `declaration`, `definition`, `scope`, `member`, `abstract`, `async`, `generator`, `synthetic`, `implicit`, `generated`, `external` |
| `core:value` | An identifiable value, binding, or storage location, including variables, constants, fields, properties, parameters, and enum members. | `declaration`, `definition`, `member`, `parameter`, `literal`, `synthetic`, `implicit`, `generated`, `external` |
| `core:operation` | An executable or evaluated source construct that needs identity for relations, flow, or evidence, including calls, assignments, returns, branches, and flow steps. | `scope`, `literal`, `call_site`, `read_site`, `write_site`, `return_site`, `import_site`, `export_site`, `branch_site`, `flow_step`, `async`, `synthetic`, `implicit`, `generated`, `external` |
| `core:resource` | A logical externally addressable or configured element, such as a route, configuration key, database object, or message topic. It is not used for ordinary language symbols that fit another base. | `declaration`, `definition`, `scope`, `member`, `member_container`, `synthetic`, `implicit`, `generated`, `external` |
| `core:construct` | A fallback semantic or synthetic construct with identity that cannot truthfully map to another entity base. Its concrete kind definition must document why no more specific base applies. | Any entity facet compatible with the concrete construct definition |

The bases are mutually exclusive for one entity record version. A concept with several roles selects its primary semantic nature as the base and expresses intrinsic secondary structure through facets or evidenced roles through facts.

## Core entity and shared facets

All facets below have `plugin_owner` omitted. Empty implication and incompatibility sets are intentional.

| Facet | Applicable universal kinds | Implies | Incompatible with | Exact intrinsic meaning |
|---|---|---|---|---|
| `core:declaration` | container, type, callable, value, resource, construct | — | — | The entity introduces or declares a semantic name or identity in source or generated semantics. |
| `core:definition` | container, type, callable, value, resource, construct | — | — | The entity supplies implementation, storage, members, or material semantics rather than only declaring them. |
| `core:scope` | container, type, callable, operation, resource, construct | — | — | The entity introduces a lookup, binding, lexical, or control scope recognized by the producer. |
| `core:member` | container, type, callable, value, resource, construct | — | — | The entity participates as a named or addressable member of another entity. Membership itself is represented by `core:contains`. |
| `core:member_container` | container, type, resource, construct | `core:scope` | — | The entity can contain named members under the language or model semantics. |
| `core:parameter` | value | `core:declaration` | `core:type_parameter` | The value is an input binding of a callable or equivalent operation. |
| `core:type_parameter` | type | `core:declaration` | `core:parameter` | The type entity is a generic or polymorphic type parameter. |
| `core:literal` | value, operation, construct | — | — | The entity directly represents a literal source or generated value rather than a named binding. |
| `core:constructible` | type | — | `core:abstract` | The type may be instantiated directly under the declared language and analysis configuration. |
| `core:abstract` | type, callable | — | `core:constructible` when applied to the same type | The entity declares incomplete behavior or contract semantics and cannot be directly materialized in its own right. |
| `core:async` | callable, operation | — | — | Invocation or evaluation has intrinsic asynchronous semantics in the source language or model. |
| `core:generator` | callable | — | — | Invocation intrinsically produces an iterator, generator, or resumable sequence under the source semantics. |
| `core:call_site` | operation | — | — | The operation is the source anchor of an invocation relation. |
| `core:read_site` | operation | — | — | The operation reads a value or storage location. It may also be a write site for read-modify-write constructs. |
| `core:write_site` | operation | — | — | The operation writes a value or storage location. It may also be a read site. |
| `core:return_site` | operation | — | — | The operation explicitly or implicitly returns control or a value from a callable. |
| `core:import_site` | operation | — | — | The operation is the source anchor of an import relation. |
| `core:export_site` | operation | — | — | The operation is the source anchor of an export relation. |
| `core:branch_site` | operation | `core:flow_step` | — | The operation selects among two or more possible control-flow successors. |
| `core:flow_step` | operation | — | — | The operation is addressable as one direct control- or data-flow step. |
| `core:synthetic` | any entity base | — | — | The analyzer created the entity to model semantics and no one-to-one source construct exists. An owner artifact remains mandatory. |
| `core:implicit` | any entity base; any relation base | — | — | The language or framework semantics create the entity or relation although it is not explicitly written at the primary span. |
| `core:generated` | any entity base; any relation base | — | — | The entity or relation originates from generated source or a deterministic generation model. |
| `core:external` | any entity base; any relation base | — | — | The entity or relation is defined outside the physical workspace and is represented through a virtual or external source artifact. |

The incompatibility between `core:abstract` and `core:constructible` applies to a type's direct constructibility. An abstract member may coexist with other constructible containing types because facets belong to individual entity records.

## Universal relation kinds

### Role-schema notation

The table below is normative shorthand for `RelationKindDefinition` and `RelationRoleDefinition`:

- Target types: `E` entity, `R` canonical record, `A` artifact, `L` literal, `U` unresolved.
- Cardinality: `1`, `0..1`, `1..*`, or `0..*`.
- `ordered` means `position` is required and unique within that role.
- The role named in the Anchor column must contain exactly one entity argument and participates in relation identity.
- Entity restrictions after `E:` are allowed universal entity kinds. An omitted restriction accepts any entity kind.
- A facet after `+` is required on the target entity.

| Universal kind | Exact role schema | Anchor / identity roles | Required facets | Exact meaning |
|---|---|---|---|---|
| `core:contains` | `container E:container,type,callable,resource,construct 1`; `contained E 1` | `contained` / `contained` | `structural_relation` | Direct semantic or lexical containment. Transitive containment is a derived traversal, not another canonical relation. |
| `core:defines` | `declaration E+declaration 1`; `definition E+definition 1` | `declaration` / `declaration` | `structural_relation` | A declaration is implemented, stored, or materially realized by a definition. |
| `core:aliases` | `alias E 1`; `target E,U 1..*` | `alias` / `alias` | `structural_relation`, `reference_relation` | The alias provides another semantic name or identity path to the target candidates. |
| `core:type_of` | `subject E 1`; `type E:type,U 1..*` | `subject` / `subject` | `structural_relation`, `reference_relation` | Declared or inferred type candidates of an entity. |
| `core:references` | `reference_site E:operation,construct 1`; `target E,U 1..*` | `reference_site` / `reference_site` | `reference_relation` | A semantic reference for which no more specific universal relation applies. |
| `core:call` | `caller E:callable,container 1`; `call_site E:operation+call_site 1`; `target E:callable,type,resource,U 1..*`; `argument E:value,operation,resource,type,L 0..* ordered` | `call_site` / `call_site` | `reference_relation` | Invocation, including construction through the `construction` facet and multiple dispatch candidates. |
| `core:read` | `context E:callable,container 1`; `read_site E:operation+read_site 1`; `target E:value,resource,U 1..*` | `read_site` / `read_site` | `reference_relation` | Reading a value or storage location. |
| `core:write` | `context E:callable,container 1`; `write_site E:operation+write_site 1`; `target E:value,resource,U 1..*`; `value E:value,operation,resource,L,U 0..1` | `write_site` / `write_site` | `reference_relation`, `flow_relation` | Writing or assigning a target, optionally with the assigned source value. |
| `core:import` | `importer E:container 1`; `import_site E:operation+import_site 1`; `imported E,A,U 1..* ordered`; `local_binding E:value,type,container 0..* ordered` | `import_site` / `import_site` | `reference_relation`, `dependency_relation` | Importing artifacts or semantic entities into a container. Matching ordered positions associate imported items with local bindings. |
| `core:export` | `exporter E:container 1`; `export_site E:operation+export_site 1`; `exported E 1..* ordered`; `alias E:value,type,container,L 0..* ordered` | `export_site` / `export_site` | `reference_relation` | Exposing entities outside a container, optionally under ordered aliases. |
| `core:inherits` | `subtype E:type 1`; `inheritance_site E:operation,construct 1`; `supertype E:type,U 1..* ordered` | `inheritance_site` / `inheritance_site` | `structural_relation`, `reference_relation` | Type inheritance or extension. It does not represent interface or protocol conformance when `core:implements` applies. |
| `core:implements` | `implementer E:type,callable 1`; `implementation_site E:operation,construct 1`; `contract E:type,U 1..* ordered` | `implementation_site` / `implementation_site` | `structural_relation`, `reference_relation` | Conformance to an interface, trait, protocol, callable contract, or equivalent abstraction. |
| `core:overrides` | `overriding E:callable,value 1`; `overridden E:callable,value,U 1..*` | `overriding` / `overriding` | `structural_relation`, `reference_relation` | Polymorphic replacement of inherited or implemented members. |
| `core:returns` | `callable E:callable 1`; `return_site E:operation+return_site 1`; `value E:value,operation,resource,L,U 0..1` | `return_site` / `return_site` | `flow_relation` | Explicit or implicit return of control and an optional value. |
| `core:binds_argument` | `call_site E:operation+call_site 1`; `argument E:value,operation,resource,type,L 1`; `parameter E:value,type,U 1..*` | `call_site` / `call_site` | `binding_relation`, `flow_relation` | Correspondence between one call argument and one or more possible parameters. The local relation key includes the source argument position without using its resolved identity. |
| `core:captures` | `callable E:callable 1`; `captured_value E:value 1..*`; `capture_site E:operation,construct 0..1` | `callable` / `callable` | `reference_relation` | Lexical capture of values by a callable or closure-like construct. |
| `core:control_flow` | `predecessor E:operation 1`; `successor E:operation 1`; `condition E:value,operation,L 0..1` | `predecessor` / `predecessor` | `flow_relation` | One direct possible transfer of control. Longer paths are derived traversals. |
| `core:data_flow` | `source E,R,L 1..*`; `sink E,R 1..*`; `flow_step E:operation+flow_step 1` | `flow_step` / `flow_step` | `flow_relation` | One direct modeled propagation step from sources to sinks. |
| `core:throws` | `callable E:callable,container 1`; `throw_site E:operation 1`; `value_or_type E:value,operation,type,L,U 1..*` | `throw_site` / `throw_site` | `flow_relation` | Production or propagation of an exception, error value, or language-equivalent effect at a concrete site. |
| `core:handles` | `handler E:callable,resource 1`; `handled E:value,type,resource,U 1..*`; `handler_site E:operation,construct 0..1` | `handler` / `handler` | `binding_relation` | A callable or resource handles errors, events, requests, or another modeled input. |
| `core:depends_on` | `dependent E 1`; `dependency E,A,U 1..*` | `dependent` / `dependent` | `dependency_relation` | An explicit dependency not represented more precisely by import, reference, call, type, or flow relations. |
| `core:binds` | `binding_site E:operation,construct 1`; `source E,L,U 1..*`; `target E,U 1..*` | `binding_site` / `binding_site` | `binding_relation` | Framework, configuration, or modeled runtime association between sources and targets. |
| `core:covers` | `test E:callable,container,resource 1`; `covered E 1..*` | `test` / `test` | `binding_relation` | Static or observed test coverage of semantic entities. Its evidence states whether coverage is inferred or measured. |
| `core:association` | `source E 1`; `target E,R,A,L,U 1..*` | `source` / `source` | — | Fallback for a genuine navigable relation with no truthful specialized base. The concrete kind must document why another universal relation does not apply. |

Roles with multiple target candidates retain independent argument evidence and confidence. A role accepting `U` uses `UnresolvedTarget`. The registered schema, not serialized array order, defines semantic order.

For each core relation kind, `required_facets` is the table's Required facets column. `allowed_facets` is the union of every relation facet whose applicability row names that kind plus the shared `core:implicit`, `core:generated`, and `core:external` facets.

## Core relation facets

| Facet | Applicable relation kinds | Implies | Exact intrinsic meaning |
|---|---|---|---|
| `core:structural_relation` | contains, defines, aliases, type_of, inherits, implements, overrides | — | The relation describes declared semantic structure rather than execution behavior alone. |
| `core:reference_relation` | aliases, type_of, references, call, read, write, import, export, inherits, implements, overrides, captures | — | At least one role semantically refers to another entity or unresolved symbol. |
| `core:dependency_relation` | import, depends_on | — | The relation contributes to dependency and invalidation analysis. |
| `core:flow_relation` | write, returns, binds_argument, control_flow, data_flow, throws | — | The relation represents direct control or data propagation. |
| `core:binding_relation` | binds_argument, handles, binds, covers | — | The relation associates semantic participants under a language, framework, configuration, or observed model. |
| `core:construction` | call | `core:reference_relation` | The invocation constructs or instantiates its target rather than performing an ordinary call. |
| `core:conditional` | any relation except contains and defines | — | The asserted relation occurs only under a source-expressed condition represented by the relation or its evidence. |
| `core:indirect` | references, call, read, write, type_of, data_flow, depends_on, binds | — | The target is reached through indirection rather than a direct named binding. Uncertainty remains represented by evidence, not by this facet. |
| `core:type_only` | import, export, references | `core:reference_relation` | The relation exists only in type-level or compile-time semantics and does not itself create a runtime dependency. |
| `core:reexport` | export | `core:reference_relation` | The exported entity originates from another container and is exposed again without becoming a new semantic definition. |

The shared facets `core:implicit`, `core:generated`, and `core:external` are registered once with both `entity` and `relation` in `applicable_categories`.

## Universal fact kinds

| Universal kind | Typed value contract | Required payload | Exact meaning |
|---|---|---|---|
| `core:semantic_role` | One registered namespaced semantic-role string | Empty | An evidence-backed architectural or framework role attributed to the fact subject. |
| `core:metric` | Integer or number matching the registered metric value type | `metric`: registered metric identifier | One reproducible measurement. The metric definition supplies unit and valid aggregations. |
| `core:constant_value` | A schema-tagged literal or closed structured constant | Empty | A value determined statically for the exact subject version and declared analysis scope. |
| `core:reachability` | `reachable`, `unreachable`, or `conditional` | `scope_record_id?`: exact record defining the analyzed scope | A reachability conclusion. Producers must not emit `unreachable` unless completeness is sufficient for that conclusion. |
| `core:effect` | One registered namespaced effect string | Empty | An observed or inferred semantic effect attributed to the subject. |
| `core:deprecation` | Boolean `true` | `replacement_record_ids[]`; `since?`; `message?` | A currently applicable deprecation assertion. A false value is represented by absence or closure of the fact, not a false deprecation record. |
| `core:assertion` | A typed value validated by the concrete kind | Concrete kind schema | Fallback independently evidenced assertion that cannot truthfully map to another fact base. |

Fact kinds have no initial core facets. Uncertainty, confidence, provenance, and lifecycle are carried by the fact and evidence models rather than facet strings.

## Core semantic roles

| Role | Allowed subject universal kinds | Required facets | Exact meaning |
|---|---|---|---|
| `core:entry_point` | container, callable, resource | — | An externally initiated boundary through which execution or processing can enter the analyzed system. Internal callers do not remove this role. |
| `core:test` | container, callable, resource | — | An entity whose primary modeled purpose is executing assertions, checks, examples, or verification scenarios. |
| `core:endpoint` | callable, resource | — | A request-addressable boundary or its directly bound handler under a registered protocol or framework model. |
| `core:configuration` | container, value, resource | — | An entity whose semantic purpose is supplying configurable behavior or values rather than ordinary program state. |
| `core:persistence` | type, resource | — | A durable data model or storage resource whose state is intended to outlive one process operation. |
| `core:event_handler` | callable | — | A callable registered or recognized as handling occurrences of an event. |
| `core:event_source` | callable, resource | — | An entity that publishes or originates modeled events. |
| `core:event_sink` | callable, resource | — | An entity that subscribes to, consumes, or receives modeled events. |

The initial core roles define no incompatible pairs. A subject may legitimately have several roles, each supported by independent evidence.

## Core metric registry

No core metrics are registered in the initial taxonomy. Metric names are not standardized until their calculation algorithm, unit, subject scope, and valid aggregation semantics can be specified without language-specific ambiguity. Plugins may register namespaced metrics through `MetricDefinition`; public operations still consume them through `core:metric` facts.

## Core effects

| Effect | Allowed subject universal kinds | Propagation policy | Exact meaning |
|---|---|---|---|
| `core:mutation` | callable, operation | `call` | The subject may modify program-visible state outside values local and unobservable to the subject. |
| `core:io` | callable, operation | `call` | The subject may perform filesystem, console, device, or other non-network external input/output. |
| `core:network` | callable, operation | `call` | The subject may send or receive data through a network boundary. |
| `core:persistence` | callable, operation | `call` | The subject may read or modify durable storage. This effect is distinct from the semantic role with the same identifier because registries are type-separated. |
| `core:exception` | callable, operation | `call` | The subject may produce or propagate an exception, error, panic, or equivalent abnormal control effect. |
| `core:concurrency` | callable, operation | `call` | The subject may create, coordinate, or interact with concurrent execution. |
| `core:nondeterminism` | callable, operation | `call` | Repeated evaluation with apparently equivalent explicit inputs may yield different observable results because of time, randomness, environment, or external state. |

Propagation produces derived possible or confirmed results according to the underlying evidence chain. It never creates new canonical effect facts automatically.

## Universal evidence and diagnostic kinds

| Category | Universal kind | Exact rule |
|---|---|---|
| Evidence | `core:evidence` | The concrete evidence kind may be plugin-specific. `basis` and `derivation` provide universal mechanism semantics; no initial evidence facets are defined. |
| Diagnostic | `core:diagnostic` | Every diagnostic record uses this concrete and universal kind. Extensibility occurs through registered `diagnostic_code` values, so competing plugin diagnostic kinds are forbidden. No diagnostic facets are defined. |

## Plugin mapping rules

1. Every concrete kind maps to exactly one universal kind in the same record category.
2. Core kinds map to themselves.
3. Required facets are always emitted; contextual facets must belong to the allowed set.
4. Plugin definitions cannot redefine any `core:*` meaning.
5. `core:construct`, `core:association`, and `core:assertion` require the concrete kind description to explain why no specialized base applies.
6. Invalid mappings or facet assignments reject the candidate delta and create the exact registered `CandidateIssue`; rejected output never becomes canonical knowledge.
7. Language-agnostic operations depend only on this registry and never require a plugin-specific kind.
8. Plugin semantic roles and effects may imply core values only when the implication is always true; concepts without a truthful core equivalent remain plugin-specific.
9. A plugin relation retains every role, anchor, and identity component of its universal relation and may only narrow the universal role schema. Additional roles are namespaced.
10. Cross-plugin enrichment creates independently owned facts or relations and never mutates another plugin's canonical record.

Representative mappings:

```text
typescript:class
  category: entity
  universal_kind: core:type
  required_facets: [core:declaration, core:scope, core:member_container]
  allowed_facets: [core:definition, core:constructible, core:abstract, core:generated, core:external]

rust:trait
  category: entity
  universal_kind: core:type
  required_facets: [core:declaration, core:scope, core:member_container, core:abstract]

python:function
  category: entity
  universal_kind: core:callable
  required_facets: [core:declaration, core:definition, core:scope]
  allowed_facets: [core:async, core:generator, core:member, core:generated, core:external]

sql:table
  category: entity
  universal_kind: core:resource
  required_facets: [core:declaration, core:definition, core:member_container]

nestjs:route_handler_binding
  category: relation
  universal_kind: core:binds
  required_facets: [core:binding_relation]

jest:test_role
  category: fact
  universal_kind: core:semantic_role
  typed_value: core:test

typescript:compiler_symbol_resolution
  category: evidence
  universal_kind: core:evidence
```

## Agent-facing registry behavior

Every returned canonical record includes its `KindDescriptor`. `KindSelector` supports concrete kinds, universal bases, required-any-excluded facet logic, and rejects empty or unknown selector values before execution.

`RegistryIncludeOptions.registry` defaults to `used`, so a response includes deduplicated concise definitions referenced by that page without another agent call. `full` registry expansion and payload schemas remain explicitly selectable and cursor-paginated under every query workspace binding and plugin version.
