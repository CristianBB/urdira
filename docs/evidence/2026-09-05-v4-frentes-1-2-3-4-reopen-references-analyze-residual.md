# v4: frentes 1-4 sobre grupo A — reopen incremental del store, referencias restantes, analyze in-process, residual con cota + `entities.index`

Fecha: 2026-09-05 (tarde/noche). Estado: **los cuatro frentes quedan COMMITEADOS** en `main`, de
`c6e29e5` (cierre de la campaña "grupo A") a `80d697c`. Corpus
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` y oráculo v3
`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-e69d-4931-b182-eea7005d20bb.sqlite`
READ-ONLY en toda la sesión (confirmado en los propios logs: `[v3] opening ... (read-only)`).
Todo lo implementado lo hicieron subagentes Sonnet en worktrees git aislados a partir del plan
`~/.claude/plans/bright-churning-wind.md`; Fable orquestó, revisó cada retorno y decidió; cada rama
tuvo revisión independiente (Sonnet) antes de fusionarse a `main`. Fuente de datos principal de esta
sesión de cierre: fichero de consolidación de hechos escrito por un subagente de medición, complementado
aquí con los logs crudos en `~/Proyectos/urdira-benchmark/v4-fold/{f123-*,f1234-*}/` y con
`git log --stat c6e29e5..80d697c` — cada cifra de este documento se contrastó contra uno de esos dos
orígenes; donde no fue posible, queda marcada explícitamente.

## 1. Pregunta de partida y respuesta

La campaña "grupo A" (cerrada el 2026-09-05 por la mañana, `docs/evidence/2026-09-05-v4-group-a-cold-
lines-references.md`) dejó una cola de cuatro frentes disjuntos por crate: (1) el reopen del store
estructural en cada scan incremental repetía trabajo O(store completo) en vez de O(delta), (2) quedaban
formas de referencia sin resolver en el syntax worker (namespaces, declaradores múltiples, `export =`,
overloads, subrutas de builtins de Node), (3) el paso `analyze` serializaba innecesariamente su
respuesta completa para callers in-process y `pnpm verify` tenía flakes de contención bajo cobertura, y
(4) el pase residual de tsgo no emitía tipos/diagnósticos cuando no había sitios de llamada pendientes,
no tenía cota de tiempo, y reconstruía su índice de entidades por full-scan en cada intento.

¿Quedan los cuatro frentes cerrados, con `pnpm verify` verde, sin regresión de paridad frente al oráculo
v3, y con las raíces Merkle incrementales coincidiendo con un cold desde cero?

Respuesta: **sí a los cuatro**. 33 commits (`c750787`..`80d697c`, ver §2 y el listado completo abajo) en
4 ramas de trabajo (`f1-store-reopen`, `f2-references`, `f3-analyze-tests`, `f4-residual`) más una rama
de arreglo (`f2b-namespace-export`, hallada por revisión al fusionar F2), fusionadas a `main` en el orden
F3 → F1 → F2 → F2b → F4 (el orden que el plan fijó para minimizar conflictos: F3 es la más pequeña y
estabiliza `verify` para el resto; F2 cierra antes de F4 porque F4 depende de `pending.sites`), más un
commit de arreglo de tipos TS (`80d697c`) tras el merge de F4. `pnpm verify` corrió sus 8 puertas de
punta a punta sobre `80d697c` y las 8 pasaron (§9). El reopen incremental pasa sus 5 tests dedicados y
`n8n_incremental_create_delete_roots_match_oracle` sigue CONFIRMADA en `09ca5ef` y en `80d697c` (raíces
+ 631.899 pending sites idénticos, §5). La paridad de referencias workspace-only mejora en 506 casos
(namespaces exportados) sin tocar `different=0`; la paridad de llamadas se mantiene en
`v4_confirmed_different_target=0` en las tres versiones medidas (§6/§7). El cold total sube +6,9% de
`09ca5ef` a `80d697c` (§3, atribuido a F4's `entities.index` + format bump 6, cola abierta, no
resuelto).

## 2. Qué se hizo (los cuatro frentes, mecanismos y ficheros)

### Frente 1 — `f1-store-reopen`: reopen incremental del store estructural (merge `37ae4d1`)

Crates: `crates/urdira-structural-store` (`reader.rs`), `crates/urdira-indexing-worker/src/v4/{delta.rs,
timings.rs,publish.rs,materialize.rs}`, `crates/urdira-worker-protocol`.

- **1.1 instrumentación** (`d03bb5a`): `ScanTimings`/`PhaseTimings`/`ScanClock` ganan
  `reopen_ms`/`close_protection_ms`/`publish_sql_select_ms`/`publish_sql_write_ms` (`Option<u64>`, serde
  `default`+`skip_serializing_if` para no romper `deny_unknown_fields`). `delta.rs` cronometra
  `StoreReader::reopen_if_changed` (rama `Changed` con lector previo) y el bloque completo de protección
  de externos; `publish.rs::publish_delta_with_kind` separa el bloque de 4 SELECT (pre-transacción) del
  bloque transaccional de 8 INSERT+commit. Hallazgo: `publish_sql_*` midió **0 ms** en la práctica — el
  SQL de publicación NO era el cuello de botella, contra la hipótesis inicial del plan.
- **1.2 `StoreInner::extend`** (`3d3b37e`, el cambio central de F1): `reopen_if_changed` intenta primero
  una vía incremental antes de caer al `StoreInner::load` completo: si el `MANIFEST` fresco es una
  extensión-por-prefijo byte-idéntica del que ya tiene el lector (mismo `base`, mismos deltas previos,
  solo deltas nuevos al final), solo esos deltas nuevos pagan el `Segment::open` completo (parseo de
  `records.meta`/`deps.meta` + sort); la base y cada delta previo se reutilizan. Trampa de corrección
  documentada y verificada con test: cada `Segment` guarda su propio `Arc<HashMap>` de closures
  (`record_closures`/`dep_closures`/`pending_closures`) fijado en `Segment::open`, y
  `effective_valid_to`/`is_visible` leen ESE campo del segmento, no uno global del store — un delta nuevo
  puede cerrar un registro que vive en un segmento MÁS VIEJO, así que los segmentos previos no se pueden
  reutilizar tal cual: se reconstruyen (clon barato de `Arc<Mmap>`/`Vec`s vía `SectionSource::File(Arc
  <Mmap>)` y `Segment: Clone` nuevos) con las closures recién fusionadas sustituidas. `dep_owner_index`
  desplaza cada entrada previa `(segment_idx, ordinal)` por el nº de segmentos nuevos en vez de
  re-parsear `deps.meta`; verificación de muestra xxh3 solo sobre el segmento nuevo. Tests nuevos:
  `reopen_incremental_matches_fresh_open` (fuzz de 5 deltas), `reopen_incremental_closes_a_base_record_
  via_a_new_delta` (caso mínimo que falla sin el fix de closures), `reopen_falls_back_on_non_prefix_
  manifest` (compact() real como caso no-prefijo).
- **1.3 protección de externos fusionada** (`58d3682`): las tres pasadas (`at-risk`/`deleted`/`zombie`)
  que llamaban `by_owner(ordinal, prev_generation)` tres veces por owner tocado ahora hacen una sola
  llamada por owner (`prev_rows_by_owner`), consumida por los tres predicados; se preserva
  deliberadamente la asimetría (at-risk filtra contra `next_identities`, deleted no tiene "next").
  `protected_external_entity_ids` (el `iter_visible` completo) queda FUERA de esta ola, solo medido.
- **1.4 `artifact_paths` reales** (`c750787`): `deps::materialize_dependencies` rellena el path real del
  artefacto target cuando internar una dependencia mintea un ordinal nuevo, en vez de dejar
  `String::new()`.
- **`ac3e6ba`** (revisión): 4 tests de cobertura añadidos sobre 1.2 (`deps_by_owner`, pending sites, dos
  deltas en un solo reopen, mtime-only sin delta nuevo) tras hallazgo de un revisor independiente.

### Frente 2 — `f2-references`: referencias y exports restantes (merge `09ca5ef`) + `f2b-namespace-export` (merge `db3cf6e`)

Crate: `crates/urdira-jsts-syntax-worker` (`lib.rs`, `resolver.rs`, `semantic_sites.rs`), más
`materialize.rs:2053` (h3).

- **3b** (`e3e5fd1`): entidad `EntityKind::Namespace` + `core:contains` para `namespace X {}` /
  `declare namespace X {}` con nombre `Identifier` (antes solo se trataba la forma ambient
  string-literal). Namespaces anidados y declaration-merging documentados, no "arreglados" aquí.
- **3c** (`7c11edd`): `visit_variable_declaration` pasa de `.first()` a iterar TODOS los declaradores de
  una `VariableDeclaration`, empujando una entidad `Variable` por cada `BindingIdentifier` (`const a = 1,
  b = 2;` ya no deja `b` sin entidad). `semantic_sites.rs`: `declarator_owns_entity` pasa de `index == 0`
  a `matches!(declarator.id, BindingIdentifier(_))`.
- **h2** (`17e15cc` + acotado por `e7b180d`): normalización de subrutas de builtins de Node
  (`fs/promises` → `node:fs/promises`). La primera versión usaba un prefijo genérico y producía falsos
  positivos (`process/browser`, `events/events`); la revisión lo cerró a una lista exacta de 11 subrutas
  documentadas por Node (`NODE_BUILTIN_SUBPATHS`).
- **h3** (`1b665cc`): `identity_key_name` deja de usar "último segmento tras `:`" para
  `external_module`/`external_symbol` (que pierde el prefijo `node:` embebido, `jsts:external_module:
  node:fs` → `fs`) y parsea por layout fijo, devolviendo el especificador completo (`node:fs`).
- **h1** (`ac69d52`): visitor nuevo para `TSExportAssignment` (`export = Identifier`), tanto a nivel de
  ambient module (`ambient_module_members`) como a nivel de fichero; alcance limitado a
  `export = Identifier` (otra forma de expresión se cuenta con un contador, no se adivina).
- **3a** (`b547cdc`, el cambio central de F2): separación de la caché de resolución de imports en
  `import_bindings_ref` (política `FirstDeclaration`) e `import_bindings_call` (política
  `UniqueOrAmbiguous`), poblados en los 3 sitios de import-specifier. Un overload set de función/método
  con >1 declaración del mismo `EntityKind` resuelve a la de menor `decl_start` para una referencia plana
  (11/11 casos confirmados contra el checker de v3 en la muestra de A5b), pero un callee de llamada
  sigue en `Ambiguous` sin excepción (no se fabrica un `core:call` sin validar contra el tipo de
  argumentos real de v3). Tercer consumidor migrado: `member_access_sub_reason`. No obvio: hubo que
  añadir `identifier_is_a_call_callee` porque `walk_call_expression` revisita genéricamente su propio
  callee tras resolverlo — sin el guard, un callee ambiguo habría filtrado una referencia RESUELTA
  mientras su `core:call` seguía correctamente pendiente. Los dos tests congelados
  (`ambiguous_multiple_declarations_in_target_stays_pending`,
  `cross_file_call_target_ambiguous_in_the_target_module_stays_pending`) quedaron verdes sin modificar.
- **F2b `e1918f8`** (hallado al fusionar F2, no en el plan original): `export namespace X {}` obtiene su
  entidad (3b) pero `declaration_export_names` nunca registraba un `SyntaxExportBinding` para
  `TSModuleDeclaration` (catch-all `_ => Vec::new()`) — 505 sitios n8n con
  `import_binding/export:unresolved|namespace` pese a existir la entidad desde 3b. Fix (b):
  `declaration_export_names` gana un arm para la forma nombrada por `Identifier`. Fix (c), necesario una
  vez expuesto por (b): `export class Foo {}` + `export namespace Foo {}` (merge class+namespace
  soportado por TypeScript) colapsan a un único `SyntaxExportBinding` mediante el `sort()`/`dedup()`
  existente, pero encuentran 2 entidades del mismo nombre — nuevo `first_declaration_merge_target`
  reconoce 3 formas bajo `FirstDeclaration` (overload set function/method; namespace repetido; exactamente
  1 candidata class/function/enum + cualquier número de namespaces → la declaración de VALOR, como
  `valueDeclaration ?? declarations[0]` de v3); cualquier otra forma se queda `Ambiguous`.
  `ExportPolicy::UniqueOrAmbiguous` (política de llamadas) queda intacta.

Tests del crate: 92 → 276.

### Frente 3 — `f3-analyze-tests`: `analyze` in-process + flakes + paridad bidireccional (merge `3456bbd`)

- **3.1** (`eede65c`): el chequeo de `max_output_bytes` que serializaba TODA la `AnalysisResult` para
  compararla con el presupuesto vivía en Rust (`SyntaxWorkerState::analyze`, `lib.rs:2080`), no en TS.
  `AnalysisBudgets` gana `enforce_output_bytes: bool` (`#[serde(default = "default_true")]` explícito,
  nunca un `#[serde(default)]` desnudo — un default desnudo daría `false` y desactivaría el guard para
  todo caller antiguo). `run_cold` (v4) y `run_jsts_generation` (v3) lo ponen a `false` (callers
  Rust→Rust in-process, sin frame IPC que acotar); el binario stdio sigue en `true`.
- **3.2** (`e351ef6`): flakes de contención bajo `--coverage` relajados sin perder la señal. `app-
  runtime.test.ts`: `secondMs < firstMs * 3` → `secondMs < firstMs` (invariante robusto, ratio real solo
  como `console.info` — no existe una señal de reutilización de pool expuesta por
  `DaemonRuntimeOptions`). `phase-index-pack.test.ts`: `URDIRA_PACK_SCALE_BOUND_MS=120000` bajo
  `test:coverage` + helper `perfBoundMs()` compartido que dobla el bound bajo `URDIRA_COVERAGE_RUN`.
  Timeouts explícitos 60s (`index-pack-v4.test.ts`) y 30s (`phase-worker-analysis-cache.test.ts`).
  `phase-canonical-query-data-port.test.ts` diagnosticado y dejado sin cambio (ya mide ~3,2s, sin
  timeout real).
- **3.3** (`4557bc7`): paridad v3-vs-v4 en `tests/v4-daemon-e2e.test.ts` pasa de subconjunto
  unidireccional (v4 ⊆ v3) a bidireccional con exclusiones nombradas
  (`KNOWN_V4_RELATION_KIND_GAPS`/`KNOWN_V4_TYPE_NAME_GAPS`), ambas verificadas vacías en vivo — sin hueco
  real encontrado.
- **3.4** (`e33870b`): extraído `classify_confirmed_possible`/`SiteFamily` compartido entre
  `residual.rs::print_confirmed_possible_histogram` y `tests_e2e.rs::inspect_store_record_histogram`
  (antes reimplementado a mano en el test). Hallazgo que contradice la expectativa "sin cambio de cifras"
  del plan: el criterio antiguo de `residual.rs` (`target_subject().is_some()`) había quedado degenerado
  desde P2-2i (2026-09-04), que empezó a dar `target_subject` también a filas `possible`/candidatas
  (distinguidas ahora por el bit de faceta `core:indirect`) — el criterio de `tests_e2e.rs` ya era el
  correcto; al compartirlo, las cifras `*_possible` IMPRESAS por `print_confirmed_possible_histogram`
  suben (dejan de estar casi en 0), efecto secundario esperado del fix, no una regresión.
  6e: no hay bug de `pnpm verify` — `coverage.thresholds` no está configurado (el gate vive en
  `scripts/check-coverage-gate.mjs`); el `exit 1` observado en la evidencia de cierre de grupo A era
  simplemente algún test fallando por los flakes de 3.2, ya cerrados.

### Frente 4 — `f4-residual`: residual sin gate global, cota de tiempo, `entities.index` persistido (merge `5aaca73`) + `80d697c`

Ficheros: `crates/urdira-indexing-worker/src/v4/{residual.rs,delta.rs,scan.rs}`,
`crates/urdira-tsgo-client/src/{residual_pass.rs,entity_index.rs,semantic_extras.rs,node.rs}`,
`crates/urdira-structural-store/src/{container.rs,layout.rs,manifest.rs,reader.rs,segment_io.rs,
writer.rs}`.

- **4.1** (`0166b8b`): elimina el `return` temprano global que saltaba tipos/diagnósticos cuando
  `collected.pending_by_owner` estaba vacío. `ResidualContext` gana `touched_owners: Option<Vec<String>>`
  (`None` en cold = todo el frontier, sin cambio; `Some(paths)` en un scan `Changed`, acotando el trabajo
  a lo tocado ∪ owners con sitios pendientes abiertos). Como `ScanCompleted` no lleva rutas en el wire
  protocol, `delta::run`/`run_one` cambian su firma a `(IndexingEvent, Vec<String>)` para pasar las rutas
  lateralmente sin tocarlo.
- **4.2** (`8f8b68f`): `ResidualPassConfig` gana `deadline: Option<Instant>`, comprobado al INICIO de
  cada ventana de `run_lane` (una ventana ya en curso siempre termina) —
  `URDIRA_V4_RESIDUAL_BUDGET_MS`, default 20s incremental / 120s cold, `0` = sin cota. `PassStats`/
  `ResidualOutcome` ganan `truncated`/`remaining_roots`/`windows_done`/`windows_total`. `schedule()` se
  re-dispara si el resultado quedó truncado, restringido a `remaining_roots`, tope 20 reintentos
  consecutivos.
- **`d717c7b`** (revisión 1/4): cierre de una carrera de epoch — el re-disparo de un intento truncado
  bumpeaba el epoch incondicionalmente, pudiendo pisar el quiet-period de un scan real concurrente. Fix:
  `should_reschedule_truncated` comprueba `current_epoch == my_epoch` justo antes de re-programar.
- **4.3** (`6b71d86`, el cambio central de F4 y el único que toca formato on-disk): nueva
  `SectionId::EntitiesIndex = 21`, fichero `entities.index`, triples ordenados `(owner_artifact u32,
  span_start u32, ordinal u32)` (`TRIPLE_STRIDE = 12`) sobre exactamente las filas `CATEGORY_ENTITY`
  excluyendo `jsts:entity_inferred_type`, escritos en base flat, base particionada, delta y compaction.
  `StoreReader::entity_by_owner_and_start` reemplaza el `iter_visible` completo (O(2,17M records)) que
  `residual::collect` pagaba en cada intento por un binary search por segmento (O(sitios)).
  **`HEADER_FORMAT`/`Manifest.format` 5→6, sin migración** — mismo contrato que el bump 4→5 de la
  campaña grupo A (decisión 26 enmendada): un store viejo falla al abrir con error explícito y se
  reindexa desde cero. `EntityLookup` (privado, en `residual.rs`) es un adaptador con dos vías: `Section`
  (default) y `Scan` (`URDIRA_V4_ENTITY_INDEX=scan`, full-scan legado, solo para comparar).
- **`f93d6e7`** (revisión 2/4): fix de `BindingElement` en `node.rs` — el primer intento de "último
  hijo Identifier gana" rompía `{a = defaultRef}` (dos hijos Identifier: `a` y `defaultRef`, "último"
  elegía mal). Señal correcta: si el primer Identifier va seguido literalmente de `:` es un rename
  (`{b: renamed}`); si no, ya es el nombre vinculado.
- **4.4** (`21bc66f`): `semantic_extras.rs::exported_declaration_indices` desciende también en
  `MODULE_DECLARATION` (miembros de namespace exportado, recursivo); `node.rs::name_start` cubre
  `BindingElement` (exports desestructurados renombrados); `residual.rs::member_kind_name` mapea los
  kinds nuevos en vez de caer a `"member"` genérico.
- **`f20f090`** (revisión 3/4): `IndexingEvent::UpgradeCompleted` gana
  `truncated`/`windows_done`/`windows_total` (`Option`, `serde(default, skip_serializing_if)`), con
  espejo TS en 3 sitios.
- **`4d7c63c`** (revisión 4/4): `entity_by_owner_and_start` no garantizaba una ganadora ESTABLE entre
  múltiples candidatas visibles con la misma clave `(owner, start)` — pasa a escanear TODOS los segmentos
  y elegir por (1) mayor `valid_from`, (2) segmento más nuevo, (3) mayor `ordinal`, documentado en el
  propio doc-comment y en la enmienda de decisión 26.
- **`80d697c`** (post-merge, fuera de las 4 ramas): `packages/engine/src/rust-workspace-scan.ts` asignaba
  los campos opcionales nuevos de `UpgradeCompleted` incondicionalmente, incluso cuando venían
  `undefined` — con `exactOptionalPropertyTypes: true` eso es un error de tipo (TS2379). Arreglado con el
  mismo patrón de spread condicional ya usado en el paquete (`native-store-convert.ts`,
  `semantic-provider.ts`).

Tests: `indexing-worker v4::residual::` 13 passed/4 ignored; `structural-store` 58 (+ `entities_index_
test.rs` nuevo); `tsgo-client` 65; `worker-protocol` 8+6.

## 3. Tiempos cold ×3 (n8n, `node scripts/v4-scan.mjs`, release)

Tres checkpoints: **A** = `c6e29e5` (antes de esta sesión), **B** = `09ca5ef` (tras fusionar F1+F2+F3),
**C** = `80d697c` final (tras fusionar F4 + el fix de tipos). Mediana calculada columna a columna sobre
las 3 corridas (mismo criterio que el cierre de grupo A), no "la corrida cuyo total es mediana".

### A — `c6e29e5` (`v4-fold/f123-cold/coldA{1,2,3}.log`)

| etapa | run1 | run2 | run3 | **mediana** |
|---|---:|---:|---:|---:|
| catalog_ms | 5.700 | 4.814 | 4.660 | **4.814** |
| parse_ms | 2.177 | 2.294 | 2.267 | **2.267** |
| resolve_ms | 2.758 | 2.010 | 2.642 | **2.642** |
| materialize_ms | 5.023 | 6.686 | 5.544 | **5.544** |
| write_ms | 5.929 | 5.520 | 5.551 | **5.551** |
| fsync_ms | 153 | 147 | 173 | **153** |
| snapshot_ms | 2 | 5 | 3 | **3** |
| total_ms | 23.514 | 23.421 | 22.721 | **23.421** |
| wall `real` | 25,57 s | 25,20 s | 24,13 s | **25,20 s** |
| RSS máx | 6,49 GB | 5,82 GB | 7,28 GB | **6,49 GB** |

Raíz `records = sha256:d01ffa009f0b6104aaf5577f7964c9e49bec6d46e011929794c5bf2f55bae8fc` en las 3
corridas (idéntica a la del cierre de grupo A y al oráculo).

### B — `09ca5ef` (`v4-fold/f123-cold/coldB{1,2,3}.log`)

| etapa | run1 | run2 | run3 | **mediana** |
|---|---:|---:|---:|---:|
| catalog_ms | 4.763 | 5.451 | 5.044 | **5.044** |
| parse_ms | 2.529 | 1.889 | 2.093 | **2.093** |
| resolve_ms | 2.207 | 2.944 | 2.350 | **2.350** |
| materialize_ms | 7.244 | 5.416 | 6.022 | **6.022** |
| write_ms | 5.292 | 5.941 | 5.202 | **5.292** |
| fsync_ms | 173 | 184 | 144 | **173** |
| snapshot_ms | 6 | 7 | 2 | **6** |
| total_ms | 23.315 | 24.393 | 23.189 | **23.315** |
| wall `real` | 25,28 s | 26,16 s | 24,56 s | **25,28 s** |
| RSS máx | 6,30 GB | 5,77 GB | 6,49 GB | **6,30 GB** |

Raíz `records = sha256:fee4ee9058055441f217b2722d00bc367096a8e4d7cd66b7b3c1b9c2cf1b959a` en las 3
corridas — DISTINTA de A (esperado: F2 añade referencias/entidades nuevas — namespaces, declaradores,
`export =` — que A no tenía). `dependency`/`graph` iguales a A. Ratio total_ms B/A = 23.315/23.421 =
**0,995** (−0,5%, dentro del ruido de máquina).

### C — `80d697c` final (`v4-fold/f1234-cold/coldB{1,2,3}.log`)

| etapa | run1 | run2 | run3 | **mediana** |
|---|---:|---:|---:|---:|
| catalog_ms | 6.005 | 5.246 | 5.064 | **5.246** |
| parse_ms | 2.150 | 2.789 | 2.233 | **2.233** |
| resolve_ms | 3.057 | 2.238 | 2.408 | **2.408** |
| materialize_ms | 5.814 | 6.220 | 6.685 | **6.220** |
| write_ms | 6.387 | 6.278 | 6.259 | **6.278** |
| fsync_ms | 161 | 170 | 162 | **162** |
| snapshot_ms | 2 | 2 | 2 | **2** |
| total_ms | 25.437 | 24.923 | 24.276 | **24.923** |
| wall `real` | 27,45 s | 26,42 s | 25,65 s | **26,42 s** |
| RSS máx | 5,87 GB | 6,48 GB | 6,03 GB | **6,03 GB** |

Raíz `records = sha256:57d4a18a41381c5547d0fe9b49569db1ba1b2b3a2647cabfc5be42bc4955f25d` en las 3
corridas — distinta de B (esperado: F2b añade 506 referencias más, ver §5). `dependency` igual a A/B;
`graph` distinto de A/B (nuevo hash, no investigado el motivo exacto — ninguna de las cuatro ramas
debería tocar el grafo de dependencias inter-artefacto; candidato para la cola si vuelve a aparecer).

### Delta C vs B (recalculado columna a columna desde los logs de esta sesión)

| etapa | B (09ca5ef) | C (80d697c) | delta |
|---|---:|---:|---:|
| catalog_ms | 5.044 | 5.246 | **+4,0%** |
| parse_ms | 2.093 | 2.233 | +6,7% |
| resolve_ms | 2.350 | 2.408 | +2,5% |
| materialize_ms | 6.022 | 6.220 | +3,3% |
| write_ms | 5.292 | 6.278 | **+18,6%** |
| fsync_ms | 173 | 162 | −6,4% |
| total_ms | 23.315 | 24.923 | **+6,9%** |
| wall `real` | 25,28 s | 26,42 s | +4,5% |

**Nota de discrepancia con `facts.md`**: el fichero de consolidación de esta sesión reporta la misma
regresión total (+6,9%, confirmado aquí) pero atribuye el desglose por etapa a "catalog +10%, parse
+10%, write +18,6%, materialize −14%". Recalculando columna a columna desde los propios logs
(`coldA/B/coldB` de `v4-fold/{f123,f1234}-cold/`) con el mismo método que produjo la tabla de arriba,
solo `write_ms +18,6%` coincide exactamente; `catalog`/`parse`/`materialize` no reproducen esas cifras
(`materialize` incluso sale con signo contrario, +3,3% no −14%) — probablemente el subagente de medición
usó una selección de corridas distinta (p. ej. comparar la corrida-1 de cada versión en vez de la
mediana por columna). Se documentan aquí los valores recalculados directamente desde los logs como los
autoritativos; el dato de `facts.md` queda marcado como reportado por el subagente, no reproducido.
`write_ms` (SQL/fsync de publicación) y `total_ms` sí están confirmados por ambas vías.

**Tamaño de store** (`du -sh .../structural`, generación 1 salvo donde se indica):
`final-A-1` (A, retenido de la campaña grupo A) = **1,8 GB**; `f123-final-B` (B, `09ca5ef`) =
**1,8 GB**; `f1234-final` (C, `80d697c`, generación 2 **post-residual**, no comparable 1:1 con las
otras dos que son generación 1 pura) = **2,1 GB**. `facts.md` reportaba 2,0 GB y 2,3 GB respectivamente
para estos dos últimos — no reproducido con `du -sh` en esta redacción; se usan aquí los valores medidos
directamente.

## 4. Incremental worker-only (`n8n_incremental_measurement`, `reopen_ms`/`close_protection_ms` nuevos en F1)

Baseline **A** (`c6e29e5`, antes de la instrumentación 1.1 — los campos `reopen_ms`/`close_protection_ms`
NI EXISTEN en el `ScanTimings` de ese build, no es que salgan `None`) y checkpoints **B** (`09ca5ef`) y
**C** (`80d697c`), 2 corridas cada uno salvo A que tiene 2 también:

| paso | A run1 / run2 (total_ms) | B run1 / run2 (total_ms, reopen_ms, close_protection_ms) | C run1 / run2 (total_ms, reopen_ms, close_protection_ms) |
|---|---:|---:|---:|
| COLD (gen 1) | 22.930 / 31.202 | 25.395 / 23.028 (n/a, n/a) | 24.556 / 23.028 (n/a, n/a) |
| EDIT#1 (gen 2) | 1.408 / 1.476 | 1.433 / 1.414 (None, 166/176) | 1.495 / 1.414 (None, 168/176) |
| EDIT#2 (gen 3) | 424 / 418 | 311 / 299 (24/23, 3/3) | 319 / 299 (22/23, 3/3) |
| CREATE (gen 4) | 375 / 355 | 251 / 274 (21/25, 3/4) | 256 / 274 (23/25, 3/4) |
| DELETE (gen 5) | 357 / 346 | 241 / 306 (25/29, 3/9) | 238 / 306 (27/29, 3/9) |
| EDIT#3 (gen 6) | 624 / 604 | 493 / 511 (18/18, 256/281) | 492 / 511 (18/18, 263/281) |
| RENAME (gen 7) | 667 / 684 | 528 / 543 (23/23, 247/263) | 522 / 543 (22/23, 254/263) |
| HUB sin cambio (gen 8) | 636 / 667 | 526 / 526 (24/25, 259/270) | 508 / 526 (20/25, 258/270) |
| HUB cambiado (gen 9) | 1.751 / 1.846 | 1.198 / 1.373 (23/20, 369/394) | 1.415 / 1.373 (23/20, 414/394) |

(Fuente: `v4-fold/f123-incr/{incrA1,incrA2,incrB1,incrB2}.log`, `v4-fold/f1234-incr/{incrB1,incrB2}.log`
— C run2 coincide con B run2 en los pasos EDIT#1..HUB por reutilizar el mismo fixture mutado entre
sesiones de bench; el COLD de C run2 es el mismo dato por el mismo motivo, confirmado línea a línea en
ambos logs). Lectura: F1 (B) ya baja EDIT#2 de ~420ms (A) a ~300-310ms y HUB-cambiado de ~1.75-1.85s a
~1.2-1.4s — el reopen incremental cuesta 18-29ms constante (no crece con la profundidad de deltas en este
rango) en vez de reconstruir el store entero; F4 (C) no cambia estas cifras de forma medible (su trabajo
vive en el pase residual en segundo plano, fuera de `ScanCompleted`). `close_protection_ms` sigue siendo
30-40% del total en HUB-cambiado (369-414ms de ~1,2-1,4s) — cola abierta, ver §10.

`n8n_incremental_create_delete_roots_match_oracle`: **CONFIRMADA** en B (`f123-incr/oracle.log`, "n8n-
scale root equality CONFIRMED", "631899 sites") y en C (`f1234-incr/oracle.log`, mismo resultado) —
igualdad de raíces del árbol create+delete-mutado frente a un cold scan desde cero, y del conjunto de
pending sites (631.899 exactos en ambos).

## 5. Paridad de referencias frente al oráculo v3 (`scripts/v4-references-parity-diff.mjs --classify-targets 1`)

v3 tiene 1.110.576 `core:references` confirmadas en todos los checkpoints (invariante, es el oráculo).

| checkpoint | `v4_same_target` | `v4_different_target` | `v4_missing` | missing→`lib` | missing→`workspace` |
|---|---:|---:|---:|---:|---:|
| B (`09ca5ef`) | 956.334 | **0** | 154.242 | 137.259 | 16.983 |
| C (`80d697c`) | 956.840 | **0** | 153.736 | 137.259 | 16.477 |

`v4_different_target = 0` en ambos — gate duro de la campaña cumplido, sin regresión. `lib` (librería
estándar de TypeScript) no se toca por ninguno de los 4 frentes, como se esperaba.

### Desglose `missing workspace` por razón × kind (workspace-only), B vs C

Fuente: `workspaceReasonByRawKindHistogram` de `refs-parity-report.json` (idéntico en cada fila salvo las
dos marcadas). Solo se listan las filas que cambian; el resto (≈75 combinaciones razón×kind) es
byte-idéntico entre B y C:

| razón/kind | B (`09ca5ef`) | C (`80d697c`) | delta |
|---|---:|---:|---:|
| `import_binding/export:unresolved` × `namespace` | 505 | **(ausente = 0)** | **−505** |
| `re_export_binding/export:unresolved` × `namespace` | 1 | **(ausente = 0)** | **−1** |

Total workspace: 16.983 → 16.477 (**−506**, exactamente F2b: la entidad `namespace` ya existía desde 3b,
pero no tenía `SyntaxExportBinding` hasta el fix (b); el caso de `re_export_binding` es el mismo patrón
vía re-export). `member_access` se mantiene en exactamente **9.793** en ambos checkpoints (idéntico dígito
a dígito en todas sus 24 sub-razones×kind) — confirma que 3a/3c/h1/h2/h3 no tocaron esta población,
consistente con el plan (3d, la forma de `member_access` restante, quedó explícitamente diferida).

**Nota sobre la cifra base citada por el plan y por `facts.md`**: el plan `bright-churning-wind.md` cita
"missing workspace (objetivo: bajar desde 18.397)" como la cifra de partida en `c6e29e5`; `facts.md`
reporta "c6e29e5 same 955.725 / diff 0 / missing ws 17.592 (evidencia §6.2; el plan citaba 18.397,
discrepancia no reconciliada)". Esta sesión no generó un `refs-parity-report.json` para el checkpoint A
(`c6e29e5`) — solo para B y C — así que ninguna de las dos cifras de partida (18.397 ni 17.592) se pudo
recontrastar aquí; ambas quedan como reportadas por fuentes previas, no re-verificadas en esta sesión. Lo
que SÍ está confirmado con los JSON crudos de esta sesión es el delta B→C (16.983→16.477, −506) y que
coincide exactamente con lo que F2b arregló.

## 6. Paridad de llamadas (`scripts/v4-call-parity-diff.mjs`)

v3: 734.379 filas `core:call` (205.468 confirmadas, 528.911 possible, 0 errores de decodificación) —
idéntico en las 4 corridas del script (B cold/after, C cold/after).

| checkpoint | v4 filas | v4 confirmadas | mismo destino | **destino distinto** | possible | sitio ausente |
|---|---:|---:|---:|---:|---:|---:|
| B cold | 729.165 | 104.146 | 91.239 (44,41%) | **0** | 110.359 (53,71%) | 3.870 (1,88%) |
| B tras residual | 727.673 | 159.926 | 114.569 (55,76%) | **0** | 87.029 (42,36%) | (no impreso, ver nota) |
| C cold | 729.165 | 104.146 | 91.239 (44,41%) | **0** | 110.359 (53,71%) | 3.870 (1,88%) |
| C tras residual | 727.673 | 159.926 | 114.569 (55,76%) | **0** | 87.029 (42,36%) | (no impreso, ver nota) |

`v4_confirmed_different_target = 0` en las 4 corridas — cifras **byte-idénticas** entre B y C tanto en
cold como tras el residual (confirmado línea a línea en
`v4-fold/{f123,f1234}-calls/call-parity-{cold,after}.log`): ninguno de los cambios de F1-F4 mueve la
clasificación confirmed/possible/missing de llamadas. (Nota: el script no reimprime la fila "sitio
ausente" en la corrida "after" en ninguno de los 4 logs — mismo formato de salida en las 4, no es un
fallo de esta sesión.)

## 7. Residual con y sin cota de tiempo

### Sin cota (`URDIRA_V4_RESIDUAL_BUDGET_MS` no fijada = default 120s en cold)

| checkpoint | wall pase residual | total_ms | inferred_type_entities | diagnostics_emitted | truncado |
|---|---:|---:|---:|---:|---|
| B (`09ca5ef`, `f123-calls/residual.log`) | 67,968 s | 62.485 | 40.382 | 248.193 | no |
| C (`80d697c`, `f1234-calls/residual.log`) | 67,945 s | 63.107 | **41.042** | 248.193 | no |

`inferred_type_entities` sube +660 (40.382→41.042) exactamente por 4.4 (miembros de namespace + exports
desestructurados ahora tipados); `diagnostics_emitted` no cambia (248.193 en ambos — 4.4 no toca
diagnósticos, solo entidades tipadas). `confirmed_combined` tras el residual: 161.794 en ambos
checkpoints (idéntico, `f123-calls/residual.log` y `f1234-calls/residual.log` líneas 110).

### Con cota `URDIRA_V4_RESIDUAL_BUDGET_MS=20000` (solo medido en C, `f1234-calls-budget/`)

Dos corridas del mismo bench, resultado distinto entre sí:

- **Corrida 1** (`residual-budget20s.log`): NO se observa el mensaje de truncamiento (`deadline hit`) en
  ningún punto del log; el pase completa igualmente en `total_ms=35.997` (35,997 s, superior a la cota de
  20 s) con `confirmed_combined=139.969`. Esto es consistente con el mecanismo documentado ("el deadline
  solo se comprueba entre ventanas, no dentro de una ventana en curso"): si las ventanas de esta corrida
  resultaron más gruesas o si la comprobación cayó justo después de completarse todo el trabajo pendiente,
  el chequeo nunca encontró una ventana que cruzara el límite. No reproducido ni diagnosticado más allá de
  esto en esta sesión (ver §10, trampa).
- **Corrida 2** (`residual-budget20s-2.log`): SÍ trunca — `v4 residual: deadline hit, windows_done=19/28
  remaining_owners=4608`, `total_ms=36.589` (36,6 s, ≈1,8× la cota nominal de 20 s, por el mismo motivo:
  el chequeo es solo al INICIO de cada ventana, así que una ventana ya en curso cuando se cumplen los 20s
  se deja terminar), `confirmed_combined=138.997` (vs 161.794 sin cota — publica una generación parcial,
  como diseñado).

El harness `n8n_residual_pass_debug_histogram` invoca `run_once` una sola vez, no `schedule` — por tanto
esta sesión NO ejerció el mecanismo de re-programación automática de `schedule()` (4.2) que reanudaría el
trabajo restante en un segundo pase; queda como hueco de cobertura de bench, no de código (el código del
re-disparo tiene su propio test unitario determinista, `splitting_the_plan_across_two_passes_matches_
one_unbounded_pass`, verde desde el commit `8f8b68f`).

### `collect()` con `entities.index` (4.3)

No hay timing aislado en el harness de bench (`resolve_started` se marca después de `collect`); el
`total_ms` del pase completo pasa de 62.485 (B, full-scan `EntityIndex`) a 63.107 (C, sección
`entities.index`) — variación plana, dentro del ruido de esta sesión; no se pudo medir el beneficio de
4.3 de forma aislada con las herramientas de bench existentes (cola, ver §10).

## 8. Layout del store e histograma de records

| métrica | B (`09ca5ef`) | C (`80d697c`) | delta |
|---|---:|---:|---:|
| records totales | 2.175.086 | 2.176.247 | +1.161 |
| RAW | 35.646 (1,64%) | 35.661 (1,64%) | +15 |
| ENTITY | 370.544 | 370.544 | 0 |
| RELATION | 1.768.896 | 1.770.042 | +1.146 |
| `jsts:relation_references` | 1.229.616 | 1.230.777 | **+1.161** |
| `jsts:entity_type` | 14.275 | 14.275 | 0 |
| `references_without_target` (diagnóstico) | 3.565 | 3.565 | 0 |
| `external_module_entities` | 911 | 911 | 0 |
| pending sites visibles | (no repetido en el log de C) | 632.055 | — |

(Fuente: `v4-fold/f123-cold/{layout,record-histogram}.log`, `v4-fold/f1234-cold/{layout,record-
histogram}.log`.) El delta de +1.161 referencias coincide con lo que produce F2 completo (3b/3c/h1 +
F2b) sobre el resto de la campaña de referencias — no se descompuso por sub-paso en esta sesión de
cierre (haría falta un cold intermedio entre cada commit de F2, no ejecutado). `MANIFEST format=6`,
`base-1/entities.index` = 4.503.856 bytes (reportado por `facts.md`; no reconstruido a partir de un log
crudo en esta redacción — el `ls -la` de la sección no forma parte de los logs de bench retenidos,
marcado como reportado por el subagente, no re-verificado).

## 9. `pnpm verify` en `80d697c`

Esta redacción no re-ejecutó la cadena completa de `pnpm verify` (coste de varias decenas de minutos,
dominado por `cargo test --workspace --locked` + `vitest run --coverage`); se reproduce aquí el resultado
literal ya obtenido por el subagente de medición dentro de la propia sesión de implementación, sobre el
mismo `80d697c` en el que queda este repositorio:

```
Test Files  139 passed | 2 skipped (141)
Tests       2083 passed | 13 skipped (2096)
coverage gate: statements 90.06% (27540/30578), critical branches 100%, semantic regions 100%
check:publication: 1005 files checked, passed
cargo test --workspace --locked: 656 passed / 0 failed
```

Marcado explícitamente: **reportado por el subagente en `facts.md`, no re-verificado con un log crudo
retenido en esta redacción** (a diferencia de las cifras de cold/incremental/paridad de §3-§7, que sí se
recontrastaron línea a línea contra ficheros en `v4-fold/`). Lo que SÍ se ejecutó y verificó en esta
misma redacción es `pnpm check:publication` sobre el propio fichero de esta evidencia (ver informe
final).

Enmienda de decisión referenciada: `docs/decisions/26-v4-structural-store.md` — sección "Per-table files
and the 64-byte header" documenta `entities.index` (F4 4.3, formato 6) junto a su layout de 12 bytes por
fila y la política "obligatoria en todo base/delta desde formato 6" (a diferencia de `pending.sites`/
`dict.bin`, que son "ausente si vacío"); confirmado presente en el fichero (`grep` líneas 87-204, §2).

## 10. No hecho / cola

1. **Atribución exacta de la regresión cold +6,9%** (§3): confirmado que `write_ms` sube +18,6% y es el
   mayor contribuyente en términos absolutos, pero no se perfiló qué fracción de ese incremento es
   escribir la sección `entities.index` (4,5 MB según `facts.md`, no reconfirmado) vs. el resto del
   trabajo de `write_hot_and_secondary_files[_partitioned]` bajo formato 6. `catalog_ms`/`parse_ms`
   también suben (+4,0%/+6,7%) sin explicación mecánica evidente en el diff de F4 — candidato a
   reinvestigar con un perfil dedicado antes de aceptar la regresión como definitiva.
2. **`graph` root distinto entre B y C** (§3): ninguno de los commits de F1-F4 debería tocar
   `graph_edges` según su propio alcance declarado; no se investigó el motivo del cambio de hash en esta
   sesión (podría ser tan simple como un orden de escritura no determinista en presencia de
   `entities.index`, o algo real — sin diagnosticar).
3. **Protección de externos sigue en 30-40% del HUB cambiado** (§4, `close_protection_ms` 369-414ms de
   ~1,2-1,4s total) — 1.3 fusionó las tres pasadas redundantes pero dejó `protected_external_entity_ids`
   (el `iter_visible` completo) sin tocar, como estaba explícitamente fuera de alcance en el plan. Índice
   inverso persistente `target_subject → owners` (precedente: `dep_owner_index`) sigue siendo el
   candidato, no implementado.
4. **Cota residual no comprobada dentro de una ventana** (§7): el deadline solo se chequea entre
   ventanas, así que una ejecución puede exceder la cota nominal hasta ~1,8-2× cuando una ventana en
   curso es cara (observado: 36,6s con cota de 20s). No instrumentado con un chequeo intra-ventana (p.
   ej. entre requests tsgo dentro de la misma ventana).
5. **Mecanismo de re-programación (`schedule`) de 4.2 no ejercido con un harness n8n real** — solo el
   test unitario sintético `splitting_the_plan_across_two_passes_matches_one_unbounded_pass` lo cubre; un
   segundo pase real sobre n8n tras un truncamiento no se corrió en esta sesión.
6. **`collect()` con `entities.index` sin timing aislado** (§7) — el beneficio de 4.3 (O(sitios) vs.
   O(2,17M records)) es un argumento estructural del propio diseño (confirmado por el propio commit
   `6b71d86` y sus tests de round-trip), pero no se pudo medir un `resolve_ms`/`collect_ms` aislado antes
   y después con las herramientas de bench existentes en n8n.
7. Heredado de la campaña grupo A y no tocado en esta sesión (`2026-09-04-v4-pending-sites-fold-and-
   member-entities.md` §8/§9.6/§10.7, `2026-09-05-v4-group-a-cold-lines-references.md` §9): overloads
   elegidos por argumentos reales (bloqueado por caché compartida en `semantic_sites.rs`); `member_access`
   restante (~9,8k, confirmado sin cambio en §5): destructuring con interfaz, cadena fluida con genéricos,
   alias en `classify_heritage_identifier`; `unresolved_global × namespace` (193, sin cambio); namespaces
   anidados `A.B` (documentados, no arreglados); `declare global {}`.
8. Tests con `binary::discover(tsgo)` deberían ser `#[ignore = "requires tsgo binary"]` en vez de
   silenciosamente pasar cuando el binario no está — hallado en vivo esta sesión (§11) pero no convertido
   en fix sistemático, solo mitigado fijando `URDIRA_TSGO_BINARY` en cada test afectado.
9. `entities.index`: una clave `(owner, start)` ambigua documentada en el fixture de test (1 caso), sin
   resolver (ambas candidatas son visibles y reales; el desempate determinista de `4d7c63c` elige una,
   consistente, pero sigue siendo una ambigüedad de fondo del propio código fuente del fixture).
10. Discrepancia entre las cifras "missing workspace" de partida citadas por el plan (18.397) y por la
    evidencia previa de grupo A (17.592) — no reconciliada en ninguna sesión hasta ahora (§5).
11. Limpieza de directorios retenidos en `~/Proyectos/urdira-benchmark/v4-fold/` (`base-0`, `ola1-1`,
    `ola2-1` de la campaña grupo A, ~6 GB; los worktrees `.claude/worktrees/agent-*` de esta sesión, 5)
    pendiente de autorización del dueño.
12. Producto (dueño, sin tocar esta sesión): huérfanos web, ramas/merges in situ, distribución de
    index-pack; coste de agentes.

## 11. Trampas encontradas esta sesión

- **Los worktrees de `isolation: worktree` arrancaron en un commit viejo pre-v4 (`7d04d49`), no en
  `HEAD`**: los 4 implementadores tuvieron que `git reset --hard <base>` sobre su propia rama antes de
  empezar a trabajar. Verificar SIEMPRE la base real del worktree como primer paso de cualquier
  subagente aislado.
- **Worktrees aislados sin `node_modules`/symlinks `@urdira/*`**: cualquier test que dependa de
  `binary::discover` (tsgo) pasaba trivialmente EN SILENCIO en vez de fallar o saltarse explícitamente,
  porque el binario simplemente no se encontraba y el camino de fallback devolvía éxito vacío. Hubo que
  fijar `URDIRA_TSGO_BINARY=<ruta al binario real de @typescript/typescript-darwin-arm64>` en todo test
  del residual para confirmar que de verdad ejercía RPC real, no un skip trivial — descubierto solo
  porque un desarrollador revisó manualmente los resultados de 4.1-4.4, no porque el test lo señalara.
  `tsc --build --force` en frío necesita varias pasadas porque ningún sub-`tsconfig.json` del repo
  declara `references` explícitas (solo el raíz) — cada pasada adicional converge una capa más
  (`engine` → `daemon` → `mcp` → `web` → `apps/urdira`) porque `tsc --build` no tiene forma de conocer el
  orden real de dependencias y cae a resolver tipos cruzados contra el `dist` que una pasada previa ya
  escribió.
- **Un subagente aislado no puede ejecutar git sobre el repo principal** ("git operations must target
  its own worktree") — los merges a `main` los tuvo que hacer un agente sin aislamiento de worktree.
- **Un integrador se paró a "esperar" un `cargo test` en background** pese a la prohibición explícita de
  la memoria/plan de no hacerlo — reanudado con `kill -0` en foreground (memoria "subagents can't wait
  across turns" confirmada vigente).
- **`check:coverage-gate`/`check:publication` ejecutados sueltos leen artefactos stale** (p. ej.
  `coverage/coverage-final.json` de una corrida anterior) y pueden parecer verdes sin haber corrido nada
  nuevo — hay que comprobar el timestamp del artefacto, no solo el código de salida del comando.
- **`exactOptionalPropertyTypes: true`** en el `tsconfig.json` raíz: nunca asignar
  `campo: valor_opcional` cuando el valor puede ser `undefined` — usar spreads condicionales (patrón ya
  establecido en `native-store-convert.ts`/`semantic-provider.ts`, reutilizado en `80d697c`).
- **Coverage medido en una rama aislada (89,15%, reportado por `facts.md` para la rama S3) difiere del
  coverage en `main` fusionado (90,07%/90,06%)**: el gate depende del árbol COMPLETO, no de los ficheros
  tocados por una rama — medir coverage en una rama aislada antes del merge subestima el % real.
- **`residual-budget20s.log` no reprodujo el truncamiento de `residual-budget20s-2.log`** pese a usar
  (presumiblemente) la misma variable de entorno y el mismo corpus (§7): una corrida completó sin cruzar
  nunca el chequeo de deadline pese a tardar más que la cota nominal, la otra sí lo cruzó. No se
  investigó la causa exacta (posible sensibilidad al tamaño/orden de las ventanas de esa corrida
  concreta) — documentado aquí como comportamiento observado, no como bug confirmado, dado que el
  mecanismo en sí (chequeo solo entre ventanas) ya explica por qué el momento exacto del corte es sensible
  al tamaño de la ventana en curso.
- **Las cifras de desglose por etapa del cold C vs B en `facts.md` no se pudieron reproducir
  recalculando desde los logs crudos** (§3) — solo `write_ms +18,6%` y `total_ms +6,9%` coinciden
  exactamente; se usan los valores recalculados aquí como autoritativos.
- **Los tamaños de store retenidos (`f123-final-B`, `f1234-final`) medidos con `du -sh` en esta redacción
  no coinciden con los citados por `facts.md`** (1,8/2,1 GB medidos vs. 2,0/2,3 GB reportados) — posible
  medición en un momento distinto (antes/después de una compactación) o redondeo distinto; se usan los
  valores medidos directamente aquí.

## Informe final

- Commits: F1 (`d03bb5a`,`3d3b37e`,`58d3682`,`c750787`,`ac3e6ba`) merge `37ae4d1`; F2
  (`e3e5fd1`,`7c11edd`,`17e15cc`,`1b665cc`,`ac69d52`,`b547cdc`,`e7b180d`) merge `09ca5ef`; F2b
  (`e1918f8`) merge `db3cf6e`; F3 (`eede65c`,`e351ef6`,`4557bc7`,`e33870b`) merge `3456bbd`; F4
  (`0166b8b`,`8f8b68f`,`d717c7b`,`6b71d86`,`f93d6e7`,`21bc66f`,`f20f090`,`4d7c63c`) merge `5aaca73`; fix
  post-merge `80d697c`. Base `c6e29e5`, final `80d697c` (33 commits no-merge + 6 merges).
- Cold ×3 por checkpoint: A (`c6e29e5`) mediana total_ms 23.421/25,20s/6,49GB; B (`09ca5ef`) 23.315/
  25,28s/6,30GB (ratio vs A 0,995); C (`80d697c`) 24.923/26,42s/6,03GB (+6,9% vs B en total_ms,
  atribución exacta por etapa NO reconciliada con `facts.md`, ver §3 y §10.1). Raíces `records`
  distintas en las 3 (esperado: cada frente añade referencias nuevas), `dependency` estable, `graph`
  cambia B→C sin explicación mecánica confirmada (cola, §10.2).
- Incremental: reopen incremental (F1) mide 18-29ms constante; EDIT#2 baja de ~420ms (A) a ~300ms (B/C);
  HUB-cambiado baja de ~1,75-1,85s (A) a ~1,2-1,4s (B/C); `close_protection_ms` sigue en 30-40% del HUB
  cambiado (cola, §10.3). `n8n_incremental_create_delete_roots_match_oracle` CONFIRMADA en B y C
  (raíces + 631.899 pending sites).
- Paridad referencias: `v4_different_target=0` en B y C; missing workspace baja 16.983→16.477 (−506),
  exactamente los dos buckets `namespace` que F2b arregló (`import_binding/export:unresolved` −505,
  `re_export_binding/export:unresolved` −1); `member_access` (9.793) sin cambio, `lib` (137.259) sin
  cambio.
- Paridad llamadas: `v4_confirmed_different_target=0`, cifras byte-idénticas entre B y C en cold
  (91.239 same) y tras residual (114.569 same).
- Residual: sin cota, `inferred_type_entities` sube +660 (40.382→41.042, exactamente 4.4) sin tocar
  diagnósticos (248.193 ambos); con cota 20s, trunca `windows_done=19/28 remaining_owners=4608` y publica
  parcial (confirmed_combined 138.997 vs 161.794) pero el pase real dura ≈1,8× la cota nominal por diseño
  (chequeo solo entre ventanas) — una de las dos corridas de esta sesión ni siquiera truncó, ver trampa
  §11.
- `pnpm verify`: 8/8 según `facts.md` (2083 passed/13 skipped, coverage 90,06%, 656 cargo tests) — NO
  re-ejecutado en esta redacción, marcado explícitamente como no re-verificado con log propio.
  `pnpm check:publication` sí se ejecutó sobre esta propia evidencia (ver resultado abajo).
- Evidencia: `docs/evidence/2026-09-05-v4-frentes-1-2-3-4-reopen-references-analyze-residual.md` (este
  fichero). Enmienda de decisión 26 confirmada presente para `entities.index`/formato 6.
- Sin anomalías de gate nuevas; las discrepancias encontradas (§3, §5, §11) son entre `facts.md` y los
  logs crudos de esta misma sesión, no entre el código y su comportamiento esperado.
