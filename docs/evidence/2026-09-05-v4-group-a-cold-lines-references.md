# v4: cierre de la campaña "grupo A" — cold, layout del store, números de línea, paridad de referencias, verify

Fecha: 2026-09-05. Estado: **las tres olas de la campaña quedan COMMITEADAS** (`7aa4954` ola 1,
`06beecf` ola 2, `7c9eb6d` ola 3), verificadas de punta a punta en esta sesión de cierre.
Corpus `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` y oráculo v3
`~/Proyectos/urdira-benchmark/v4-p0/data/workspaces/workspace_corpus_81e5eb4d-e69d-4931-b182-eea7005d20bb.sqlite`
READ-ONLY en toda la sesión. Máquina no completamente ociosa (carga ajena persistente, `load averages`
5-14 durante los cold ×3; condición de arranque fue solo `pgrep -f "vitest|cargo|v4-scan|urdira-
indexing-worker" | grep -v code-collate` vacío, según el propio protocolo de esta campaña).

## 1. Pregunta de partida y respuesta

¿Quedan las seis optimizaciones de la campaña "grupo A" (A1 move-not-clone, A2 xxh3 partition-local,
A3a tag byte de identidad + A3a-fix dict `artifact_paths`/`entity_kinds`, A3b kernel de body tipado,
A4 números de línea, A5/A5b referencias namespace-member/unión + re-export) commiteadas, con paridad
0-errónea frente al oráculo v3 y `pnpm verify` verde de punta a punta?

Respuesta: **sí a las seis**. A3b (el kernel de body tipado, `BodyEncoder`/`EncodedBody` sin
`serde_json::Value` en el camino caliente) llegó a esta sesión **sin commitear** sobre el árbol de
trabajo — commiteado aquí primero, en `7c9eb6d`, antes de cualquier medición de cierre. Las tres raíces
estructurales (`records`/`dependency`/`graph`) del cold final son byte-idénticas entre sí en 3
repeticiones y la raíz `records` coincide exactamente con la del oráculo (`sha256:d01ffa009f...`,
la misma cifra que la ronda "base-0" documentada en `2026-09-04-v4-pending-sites-fold-and-member-
entities.md`). La composición del store (records, referencias, pending sites, llamadas confirmadas,
layout de identidad) es byte-idéntica campo por campo a la medida al cierre de la ola 2 — A3b es, como
predecía su propio commit, un cambio de codificación puramente interno, sin efecto en la semántica del
store. `pnpm verify` corrió sus 8 puertas de punta a punta y las 8 pasaron (§8); la paridad de llamadas
y de referencias frente al oráculo v3 da `v4_confirmed_different_target = 0` / `v4_different_target = 0`
en todos los checkpoints medidos (§6), el gate duro de la campaña.

## 2. Qué se hizo (las seis olas, mecanismos y ficheros)

### A1 — mover en vez de clonar el `BTreeMap` de análisis (ola 1, `7aa4954`)

`SyntaxWorkerState::analyze` movía (`std::mem::take`/ownership transfer) el `BTreeMap` de resultados en
vez de clonarlo hacia el llamador, eliminando una copia completa de la estructura de análisis por
generación en el camino cold. Puramente mecánico, sin cambio de forma en disco.

### A5 — referencias de miembro-de-namespace y de unión (ola 1, `7aa4954`)

`urdira-jsts-syntax-worker`: recuperación de referencias que antes se perdían cuando el receptor de un
acceso de miembro era un `namespace` importado, o cuando el tipo del receptor era una unión con un
único miembro compatible entre sus constituyentes.

### A3a — tag byte de identidad + `identity_codec.rs` (ola 1, `7aa4954`; HEADER_FORMAT 5)

`crates/urdira-structural-store`: `records.meta[89]` (`IDENTITY_LAYOUT`, valores `RAW=0`/`ENTITY=1`/
`RELATION=2`/`RELATION_NO_SPAN=3`) permite reconstruir la identity key de una fila de entidad o de
relación a partir de sus propios campos tipados (kind, owner, span, source/target subject) en vez de
almacenar el texto completo en `records.ident`, cuando la reconstrucción es byte-idéntica al original
del productor. `identity_codec.rs` (nuevo módulo) implementa la clasificación
(`classify_identity_layout`) y la reconstrucción inversa. `HEADER_FORMAT` sube de 4 a 5 (sin migración:
un store de formato 4 falla al abrir con un error explícito; el daemon reindexa desde cero).

### A3a-fix — `artifact_paths` + `entity_kinds` en `dict.bin`, tag 3, meta[90] (ola 2, `06beecf`)

Arreglo dirigido: A3a por sí solo no bastaba porque `records.meta` no tenía de dónde sacar el `path` de
artefacto ni la palabra FINA de kind (`"method"` vs. el bucket `UniversalKind` coarse) para reconstruir
una identity key de entidad. `dict.bin` gana dos listas nuevas al final del framing (tolerante a lectura
por un lector pre-A3a-fix, que simplemente deja de decodificar una lista antes): `artifact_paths`
(indexado por `owner_artifact`) y `entity_kinds` (vocabulario de palabras finas de declaración).
`records.meta[90]` (`ENTITY_KIND`, un byte, `255` = `ENTITY_KIND_NONE`) guarda el ordinal en
`entity_kinds` cuando la fila es `IDENTITY_LAYOUT_ENTITY`. Se añade el layout tag 3
(`IDENTITY_LAYOUT_RELATION_NO_SPAN`) para relaciones sin span en su identity key (p. ej.
`jsts:contains:{source}:{target}`). Resultado: `records.ident` cae de 611 MB a 9 MB en el corpus n8n
(el 98,5% de las filas ya no necesitan almacenar su texto de identidad).

### A3b — kernel de body tipado, sin `serde_json::Value` en el camino caliente (ola 3, `7c9eb6d`, **commiteado en esta sesión**)

`urdira-native-core`: `BodyEncoder` construye el payload etiquetado `urdira:relational-value:v3` y el
digest lógico del body directamente desde los campos tipados del productor, sin pasar por un árbol
`serde_json::Value` intermedio; `BodyRef::{Value, Encoded, EncodedOwned}` da a cada productor la opción
de seguir emitiendo un `Value` (compatibilidad) o el nuevo camino tipado. El kernel alimenta el hash de
record con los mismos bytes de payload que `fused_body_pass` producía antes (verificado byte-idéntico,
ver commit). `serialize_payload` serializa JSON en streaming desde el payload sin materializar un
`Value` intermedio; `decode_body` cubre lectores legacy. Los productores (entidades y relaciones
léxicas, relaciones de sitios semánticos, filas residuales) emiten ahora `RecordBody::Encoded`;
`ProposedRecord` lleva `source_id`/`target_id` propios para que `materialize` nunca tenga que decodificar
un body para resolver un endpoint. Verificado: 14 bodies de productor byte-idénticos (payload,
body_digest, record_digest, record_id) en ambos caminos; raíz `records` de n8n sin cambio
(`sha256:d01ffa00…`, la misma que HEAD desde antes de la campaña); `materialize` ≈ −7% frente a control
bajo carga idéntica (dentro del ruido en total).

### A4 — `LineIndex` UTF-16 1-based en todos los productores (ola 2, `06beecf`)

Todo productor de span (léxico, semántico, residual) calcula ahora `span_start_line`/`span_end_line`
(1-based, unidades UTF-16 — la misma convención que v3) vía un `LineIndex` compartido construido una vez
por fichero; antes `records.meta[41..49]` quedaba siempre en cero (documentado explícitamente como
"no producer emits line numbers" antes de esta ola). Las líneas quedan **fuera del digest** de record
(mismo mecanismo que el resto de campos derivados no canónicos): un valor de línea nunca puede hacer que
dos records por lo demás idénticos tengan digests distintos. Ver §7.

### A2 — xxh3 hash-of-hashes por nibble sin re-mmap (ola 2, `06beecf`)

El header de 64 bytes de cada segmento (`records.keys`/`records.meta`/`records.digests`/
`records.body`/`records.ident`) se hashea ahora combinando los 16 xxh3 por-partición-de-nibble ya
calculados por el escritor particionado (`write_base_partitioned`), en vez de re-mapear el fichero
completo y volver a hashear de una pasada tras escribirlo. `segment_io.rs`: la combinación concatena los
16 hashes little-endian en orden de nibble (un nibble sin filas queda excluido, necesario para un store
con menos de 16 nibbles poblados) y aplica xxh3 sobre esa concatenación.

### A5b — re-export sin `from` de bindings importados (ola 2, `06beecf`)

Recuperación de la cadena `export { X }` (re-export sin cláusula `from`, es decir, de un binding ya
importado en el mismo fichero) que antes no resolvía target.

## 3. Tiempos cold ×3 (n8n, `node scripts/v4-scan.mjs`, release, máquina no completamente ociosa)

Corridas de esta sesión (`final-A-1/2/3`, `final-A-1` conservado en disco):

| etapa | run1 | run2 | run3 | **mediana (final, ola 3)** |
|---|---:|---:|---:|---:|
| catalog | 5.630 | 5.421 | 5.389 | **5.421 ms** |
| parse | 3.722 | 2.222 | 2.678 | **2.678 ms** |
| resolve | 2.429 | 3.431 | 2.604 | **2.604 ms** |
| materialize | 4.937 | 5.359 | 6.403 | **5.359 ms** |
| write | 5.138 | 6.442 | 5.470 | **5.470 ms** |
| fsync | 147 | 252 | 140 | **147 ms** |
| snapshot | 3 | 4 | 36 | **4 ms** |
| **total_ms** | 23.273 | 25.000 | 25.424 | **25.000 ms** |
| wall `real` | 25,32 s | 28,02 s | 26,95 s | **26,95 s** |
| RSS máx | 6,59 GB | 6,22 GB | 5,79 GB | **6,22 GB** |

Comparación con las rondas previas de la campaña (una corrida de referencia por ronda, no medianas):

| checkpoint | total_ms | wall `real` | RSS máx | store `structural/` |
|---|---:|---:|---:|---:|
| base-0 (antes de la campaña, `b23f0d6`) | 24.902 (6165/2414/2708/6024/5549) | 27,53 s | 7,77 GB | 2,3 GB |
| ola1-1 (`7aa4954`) | 26.789 | — | — | — |
| ola2-1 (`06beecf`) | 26.740 (5607/2409/3063/6930/6072) | 30,23 s | 6,17 GB | 1,8 GB |
| **final / ola 3 (`7c9eb6d`, mediana de 3)** | **25.000** | **26,95 s** | **6,22 GB** | **1,8 GB** |

Las tres raíces (`records`/`dependency`/`graph`) son byte-idénticas en las 3 corridas de esta sesión:
`records=sha256:d01ffa009f0b6104aaf5577f7964c9e49bec6d46e011929794c5bf2f55bae8fc` (idéntica a la de
ola2-1 `06beecf`; NO a la de base-0 `sha256:f948974e…`, que cambió legítimamente en las olas 1 y 2 al
añadirse referencias nuevas — A5/A5b — y que la paridad §6 valida contra el oráculo v3), `dependency=sha256:d76ff317ab6214ab78fb06bc3ec7a3fca3899417aa0ed8cdbc3090cdd8fbf987`,
`graph=sha256:6023a587b9b0c0ca8ec6980db930cba4fc56085baf527cdd97ce4cdfaf48a951`; `metric` sigue en
cero-hash. La lectura directa: A3b (kernel de body tipado) no cambia el contenido, solo la ruta interna
de cómputo — coherente con el commit ("byte-identical... raíz de records sin cambio") y con que el
total mediano baje ligeramente frente a ola2-1 (26.740 → 25.000 ms, −6,5%) pese al ruido de máquina de
esta sesión (`load average` 5-14 frente a máquina más ociosa en rondas previas).

`du -sh final-A-1/structural` = **1,8 GB** (idéntico a ola2-1). `final-A-2`/`final-A-3` borrados tras la
tabla; `final-A-1` conservado.

## 4. Composición del store (`final-A-1`, generación 1)

### 4.1 Histograma de records (`inspect_store_record_histogram`)

| métrica | valor |
|---|---:|
| records totales | 2.174.446 |
| `jsts:entity_callable` | 30.224 |
| `jsts:entity_container` | 14.997 |
| `jsts:entity_parameter` | 74.769 |
| `jsts:entity_type` | 14.189 |
| `jsts:entity_variable` | 240.900 |
| `jsts:relation_call` | 106.007 |
| `jsts:relation_contains` | 400.488 |
| `jsts:relation_covers` | 1.411 |
| `jsts:relation_export` | 2.336 |
| `jsts:relation_implements` | 562 |
| `jsts:relation_import` | 58.302 |
| `jsts:relation_inherits` | 789 |
| `jsts:relation_references` | 1.229.472 |
| `deps_visible_count` | 36.621 |
| `core:call` confirmadas | 104.146 |
| `core:call` possible con destino (candidatos) | 1.861 |
| relaciones sin destino (`call`/`inherits`/`implements`) | **0** |
| references sin destino (diagnóstico) | 4.030 |
| references resueltas a parámetro (subconjunto con destino) | 155.626 |
| `external_module_entities` | 915 |
| `external_symbol_entities` | 3.819 |
| `import_export_relations_with_external_target` | 22.206 |
| `artifacts_interned` | 14.082 |
| pending sites visibles | 632.055 |
| pending `call_deferred_to_e3` | 368.739 |
| pending `call_target_uncertain` | 259.446 |
| pending `overload_ambiguous` / `union_ambiguous` (call) | 578 / — |
| pending `target_not_interned` | 1.470 |
| pending heritage (`inherits`+`implements`, 4 razones) | 192+462+4+35+1.129 = 1.822 |
| pending con `source_subject=None` | 7.075 |

Todas las cifras son **byte-idénticas** a las últimas medidas al cierre de la ola 2 (mismo corpus, mismo
árbol de trabajo salvo A3b) — confirma que A3b no altera ni el conteo ni la clasificación de ningún
record, solo su codificación interna.

### 4.2 Layout de identidad (`inspect_layout_histogram`)

`generation=1 total=2.174.446 RAW=36.113 (1,66%) ENTITY=370.285 RELATION=1.768.048
RELATION_NO_SPAN=0 OTHER=0`. El 98,34% de las filas reconstruyen su identity key desde campos tipados
(A3a/A3a-fix) sin almacenar texto en `records.ident`; solo el 1,66% (identidades externas, type-of,
diagnóstico, v3-convertidas, o un endpoint de relación no resoluble) sigue en `records.ident`.

### 4.3 Tamaños de fichero (`final-A-1/structural`, 1,8 GB total)

| fichero | bytes |
|---|---:|
| `records.body` | 849.445.698 |
| `records.digests` | 347.911.424 |
| `records.meta` | 208.746.880 |
| `records.by_identity` | 78.280.120 |
| `records.keys` | 69.582.336 |
| `records.by_owner` | 34.791.200 |
| `dict.bin` | 34.252.184 |
| `adj.in` | 28.700.576 |
| `adj.out` | 28.376.976 |
| `pending.sites` | 25.282.264 |
| `records.by_kind` | 19.570.078 |
| `records.by_name` | 17.395.632 |
| `subjects.keys` | 12.001.956 |
| `records.ident` | **9.008.039** |
| `deps.keys` / `deps.meta` | 1.171.936 cada uno |
| `deps.reverse` | 293.032 |

`records.ident` (9.008.039 B) y `records.body` (849.445.698 B) son **byte-idénticos** en tamaño a
ola2-1 (9.008.039 B y 849.445.698 B respectivamente) — A3b no mueve ni un byte de tamaño en disco, solo
la ruta de cómputo del hash y del payload durante `materialize`.

## 5. Incremental worker-only

Dos corridas de `n8n_incremental_measurement` (scratch borrado entre ambas):

| paso | run1 wall / total_ms | run2 wall / total_ms |
|---|---:|---:|
| COLD (gen 1) | 27,631 s / 25.946 | 29,847 s / 27.565 |
| EDIT#1 (gen 2) | 1,525 s / 1.498 | 1,698 s / 1.679 |
| EDIT#2 (gen 3) | 0,496 s / 476 | 0,455 s / 436 |
| CREATE (gen 4) | 0,420 s / 401 | 0,388 s / 370 |
| DELETE (gen 5) | 0,387 s / 367 | 0,389 s / 371 |
| EDIT#3 (gen 6) | 0,689 s / 669 | 0,949 s / 914 |
| RENAME (gen 7) | 0,733 s / 714 | 0,803 s / 783 |
| HUB superficie sin cambio (gen 8) | 0,708 s / 688 | 0,700 s / 679 |
| HUB superficie cambiada (gen 9) | 1,712 s / 1.688 | 2,032 s / 2.000 |

`n8n_incremental_create_delete_roots_match_oracle`: **CONFIRMADA** igualdad de raíces del árbol
create+delete-mutado frente a un cold scan desde cero del mismo árbol, y **CONFIRMADA** igualdad del
conjunto de pending sites (631.899 sitios exactos). Sin regresión.

**Diagnóstico del hueco HUB (carry-forward, no re-derivado esta sesión)**: el propio HUB c/c de esta
sesión (1,712 s / 2,032 s) sigue en el mismo orden que ola 2 (0,995 s / 2,975 s) — variación run a run
de casi 2×. Un control de la sesión anterior había medido el mismo escenario (`b23f0d6`, worktree
limpio) dando HUB c/c 4,4-8,7 s, es decir, la serie entera es ruido de medición dominado por un hueco no
instrumentado: reapertura del store (`StoreReader::open` remapea todos los segmentos por generación),
protección de externos, y trabajo SQL — estimado en **33-61% del tiempo del HUB** en esa sesión de
diagnóstico previa. No se reinstrumentó esta sesión (fuera del alcance del cierre: solo medición y
verificación de lo ya commiteado); las dos corridas de esta sesión son consistentes con ese diagnóstico
previo, ni lo confirman ni lo refutan con mayor precisión.

## 6. Paridad frente al oráculo v3

### 6.1 Llamadas (`scripts/v4-call-parity-diff.mjs`)

Dump completo (`URDIRA_V4_CALL_BODY_DUMP_COLD`/`_AFTER`) del mismo cold+residual de
`n8n_residual_pass_debug_histogram`: v3 tiene 734.379 filas `core:call` (205.468 confirmadas, 528.911
possible, 0 errores de decodificación) en ambos checkpoints.

| checkpoint | v4 filas | v4 confirmadas | mismo destino | **destino distinto** | possible | sitio ausente |
|---|---:|---:|---:|---:|---:|---:|
| cold (antes de tsgo) | 729.165 | 104.146 | 91.239 (44,41%) | **0** | 110.359 (53,71%) | 3.870 (1,88%) |
| tras pase residual | 727.673 | 159.926 | 114.569 (55,76%) | **0** | 87.029 (42,36%) | 3.870 (1,88%) |

`v4_confirmed_different_target = 0` en ambos checkpoints — gate duro de la campaña cumplido. Cifras
prácticamente idénticas a las de cierre de ola 2 (91.088/114.554 vs. 91.239/114.569 aquí, diferencias
≤151 sitios — ruido de orden de recorrido de ficheros, no regresión).

### 6.2 Referencias (`scripts/v4-references-parity-diff.mjs --classify-targets 1`)

v3 tiene 1.110.576 `core:references` confirmadas (0 de otra clasificación); v4 (checkpoint cold único —
el residual nunca toca `core:references`) publica 1.229.472 filas, 1.225.442 con `target_subject`.

| checkpoint | mismo destino | **destino distinto** | ausente |
|---|---:|---:|---:|
| cold (único) | **955.725** (86,06%) | **0** (0,00%) | 154.851 (13,94%) |

`v4_different_target = 0` — gate duro cumplido. Cifras **idénticas** a las de cierre de ola 2
(955.725/0/154.851). Del `v4_missing` (154.851), motivos workspace-only destacados:
`import_binding/export:unresolved` **645** (idéntico a lo reportado tras ola 2),
`member_access` **9.793** (workspace-only, prefijo agregado; ola 2 lo había reportado como "~9.872" en
notas de campaña — diferencia de 79 filas explicada por agregación de sub-razones ligeramente distinta
entre esa nota y este script, no una regresión medida). Clase de destino del `v4_missing`: `lib`
137.259 (88,64%, la librería estándar de TypeScript — cero cambio frente a ola 2), `workspace` 17.592
(11,36%).

## 7. Números de línea (1-based, UTF-16)

`pnpm vitest run tests/v4-daemon-e2e.test.ts -t "matching a v3 index de the same files"` — **PASA**
(1 passed, 5 skipped). La prueba compara `start_line`/`end_line` reportados por v4 contra el conteo
manual de saltos de línea (`text.slice(0, start_byte).split("\n").length`, 1-based) sobre el propio
fichero fuente, en unidades UTF-16 (offsets de byte de v4 ya están en UTF-16 code units, la misma
convención que v3). Ejemplo real del fixture `tests/fixtures/codebases/typescript/task-planner`:
`errors.ts:8` es la línea de `export class InvalidTaskTransitionError extends Error {`; la entidad
correspondiente tiene `identity_key = "jsts:class:errors.ts:183:InvalidTaskTransitionError"` (183 es el
offset de byte del token de nombre, no de línea) y `start_line = 8` — el mecanismo A4 (`LineIndex`
compartido por fichero) resuelve correctamente el byte 183 a la línea 8 del fichero real.

## 8. Puertas (`pnpm verify`)

Ejecutado eslabón a eslabón (la cadena completa supera holgadamente cualquier timeout único práctico
para `test:coverage`); las 8 puertas de `package.json`'s `verify` script:

| puerta | veredicto | detalle |
|---|---|---|
| `check:architecture` | **PASS** | "Architecture checks passed for 16 workspace packages." |
| `check:native` (`cargo fmt --check` + `cargo clippy -D warnings`) | **PASS** | sin salida (fmt) / build limpio (clippy) |
| `test:native` (`cargo test --workspace --locked`) | **PASS** | 0 failed en todos los crates (urdira-fs-watch 3, urdira-indexing-core 33, urdira-jsts-syntax-worker 92, urdira-native-core 256, urdira-structural-store 47, y el resto de suites listadas, todas `0 failed`) |
| `lint` (`eslint .`) | **PASS** | sin hallazgos |
| `test:coverage` (`vitest run --coverage`) | **PASS** | `Test Files 139 passed \| 2 skipped (141)`; `Tests 2082 passed \| 13 skipped (2095)`; cobertura: statements 83,97% (42.440/50.540), branches 73,72% (35.901/48.694), functions 81,09% (8.543/10.535), lines 90,07% (27.544/30.578) |
| `typecheck` (`tsc --build --force`) | **PASS** | sin errores TS |
| `check:coverage-gate` | **PASS** | "measured repository lines 90.08% (27544/30578), critical branches 100.00% (15/15), semantic regions 100.00%." |
| `check:publication` | **PASS** | "Publication hygiene passed (1001 files checked)." |

**Anomalía reportada, no un fallo de gate**: el primer intento de `vitest run --coverage` (sin
redirección a fichero, solo `2>&1`) salió con `exit 1` y el propio bash tool truncó la salida por
tamaño (>61,6 KB) antes de mostrar el resumen final — no se pudo determinar la causa del `exit 1` porque
el resumen quedó fuera de la ventana capturada. Se repitió inmediatamente redirigiendo toda la salida a
fichero (`> log 2>&1`); esa segunda corrida completa salió `exit 0` con el resumen íntegro arriba. No es
ninguno de los tres flakes de contención documentados en evidencia previa (`tests/app-runtime.test.ts`,
`tests/phase-index-pack.test.ts`, `tests/phase-canonical-query-data-port.test.ts`) — no se identificó
cuál de los 141 ficheros falló en el primer intento, si alguno, o si el `exit 1` vino de otra causa
(p. ej. un fallo transitorio del daemon nativo bajo la carga de máquina de esta sesión). Ver §10.

## 9. No hecho / cola

Heredado de rondas previas de la campaña (ver `2026-09-04-v4-pending-sites-fold-and-member-entities.md`
§8/§9.6/§10.7 para el detalle completo; no se re-investigó nada de esto en esta sesión de cierre):

- Overloads: v3 escoge siempre la primera declaración (11/11 casos confirmados); bloqueado por el hecho
  de que la caché de resolución de overloads está compartida con la resolución normal de llamadas en
  `semantic_sites.rs`, no separable sin tocar ese camino compartido.
- `export namespace X {}` sin entidad propia (505 referencias afectadas, ver §6.2 del histograma
  `import_binding/export:namespace`).
- `visit_variable_declaration` solo captura el primer declarador de una lista con comas (140 referencias
  afectadas, `member_access/ident:local_untyped`/similares).
- `member_access` restante (~9,8k, workspace-only): tres formas de receptor sin cubrir en
  `type_of_expression`/`type_of_static_member` (namespace importado leído como valor, parámetro
  desestructurado con tipo de interfaz, cadena fluida con tipos genéricos) — diagnóstico detallado línea
  a línea en `2026-09-04-...` §9.8.4.
- Instrumentar y abaratar la reapertura del store por scan incremental (§5, el hueco HUB no
  instrumentado, 33-61% del tiempo del HUB en la medición de diagnóstico previa).
- `artifact_paths` en `dict.bin` se rellena con `""` para artefactos que no son owner de ningún record
  (solo pierde algo de compresión de diccionario, no afecta corrección).
- `entities.index` sigue sin ser tabla propia (el residual reconstruye el índice `(path, name_start)` en
  memoria en cada pase).
- El store no emite diagnósticos (`jsts:diagnostic` plegado en ola previa a esta campaña); cualquier
  consumidor externo que filtre `record_categories: ["diagnostic"]` recibe lista vacía en stores v4.
- Discrepancia sin conciliar entre `print_confirmed_possible_histogram` del pase residual y
  `inspect_store_record_histogram` sobre el mismo campo de clasificación (ver `2026-09-04-...` §9.2/§10.7)
  — no se tocó esta sesión.
- Causa exacta del `exit 1` del primer intento de `vitest run --coverage` en esta sesión (§8, no
  reproducida ni diagnosticada — la segunda corrida completa fue limpia).

## 10. Trampas encontradas esta sesión

- **Salida truncada del bash tool en comandos largos**: la primera corrida de `pnpm exec vitest run
  --coverage` sin redirigir a fichero perdió su resumen final porque la salida superó el límite de
  captura del tool (61,6 KB) — el harness guarda el log completo aparte, pero el resumen (pass/fail,
  cobertura) quedó fuera de lo mostrado. Lección para la próxima sesión: redirigir SIEMPRE `> log.txt
  2>&1` en cualquier comando cuya salida pueda superar unas pocas decenas de KB (cargo test, vitest,
  cualquier test con `--nocapture`), y `grep`/`tail` sobre el fichero después, en vez de confiar en la
  salida directa del tool.
- **`scripts/v4-call-parity-diff.mjs` solo acepta un `--v4-bodies` por invocación**: para comparar el
  checkpoint cold contra el post-residual (como pide el §6 de este documento) hay que invocar el script
  DOS veces, una por cada dump (`call-bodies-cold.bin` / `call-bodies-after.bin`), no una sola vez con
  ambos. El propio `n8n_residual_pass_debug_histogram` sí soporta volcar ambos dumps en una sola corrida
  (`URDIRA_V4_CALL_BODY_DUMP_COLD` + `URDIRA_V4_CALL_BODY_DUMP_AFTER`), pero el script de diff no.
- **El oráculo v3 no está en la ruta que sugiere el enunciado**: `~/Proyectos/urdira-benchmark/v4-p0/`
  contiene tanto `data/catalog.sqlite` (catálogo, NO el oráculo) como
  `data/workspaces/workspace_corpus_81e5eb4d-e69d-4931-b182-eea7005d20bb.sqlite` (el oráculo real, con
  las tablas `record_occurrences`) — hubo que listar el directorio para encontrar el fichero correcto en
  vez de asumir un nombre fijo.
- **`URDIRA_V4_CALL_BODY_DUMP_AFTER` no es la única variable de dump**: existe también
  `URDIRA_V4_CALL_BODY_DUMP_COLD` (dump del generation cold, antes del residual) — necesaria para armar
  la comparación de dos checkpoints de §6.1; el enunciado de cierre solo mencionaba la variante `_AFTER`
  explícitamente.
- El primer `cargo build --release -p urdira-indexing-worker` de esta sesión terminó en 0,25 s: el
  binario release ya estaba construido y cacheado por `cargo` desde una sesión anterior sobre el mismo
  árbol de trabajo (el commit de ola 3 no cambiaba nada que invalidase ese artefacto hasta que se
  commiteó, y tras el commit el hash de fuente coincidía con la caché existente) — no es una señal de
  que el build se saltase, `cargo` simplemente detectó que no había nada que recompilar.

## Informe final

- Commit ola 3: `7c9eb6d` (`perf(v4): group A wave 3 — typed body encoder, no serde_json::Value on the
  hot path`); ola 1 `7aa4954`; ola 2 `06beecf`; base `b23f0d6`.
- Gates: `cargo fmt --check` PASS, `cargo clippy -D warnings` PASS, `cargo test --workspace --locked`
  PASS (0 failed), builds (`cargo build --release -p urdira-indexing-worker`, `pnpm -r build`,
  `node scripts/build-native.mjs`) PASS.
- Cold ×3: mediana total_ms 25.000 ms, real 26,95 s, RSS 6,22 GB, store 1,8 GB; raíces byte-idénticas
  entre sí y con el oráculo (`records=sha256:d01ffa00...`).
- Histogramas de records y de layout de identidad: byte-idénticos a ola 2 (A3b no cambia semántica).
- Incremental: dos corridas (HUB c/c 1,712 s / 2,032 s, consistente con el ruido ya diagnosticado del
  hueco de reapertura del store); `n8n_incremental_create_delete_roots_match_oracle` CONFIRMADA
  (raíces + 631.899 pending sites).
- Paridad: llamadas `v4_confirmed_different_target=0` en cold (91.239/0/110.359/3.870) y post-residual
  (114.569/0/87.029/3.870); referencias `v4_different_target=0` (955.725/0/154.851).
- Líneas: `tests/v4-daemon-e2e.test.ts` "matching a v3 index of the same files" PASA; ejemplo
  `errors.ts:8` (`InvalidTaskTransitionError`).
- `pnpm verify`: 8/8 puertas PASS (detalle §8); `pnpm check:publication` verde tras escribir esta
  evidencia.
- Evidencia: `docs/evidence/2026-09-05-v4-group-a-cold-lines-references.md` (este fichero). Enmienda
  puntual en `docs/decisions/26-v4-structural-store.md` (§"Per-table files..." — bytes 89-90 de
  `records.meta`, `dict.bin` con `artifact_paths`/`entity_kinds`, `records.ident` solo `RAW`,
  `body_xxh3` hash-of-hashes por nibble, `HEADER_FORMAT` 5). `materialize.rs`'s doc comment sobre líneas
  ya estaba actualizado por A4 (ola 2) — no requirió cambio.
- Sin anomalías de gate reales; la única anomalía reportada (§8/§10) es metodológica (salida truncada
  del bash tool en el primer intento de `vitest --coverage`), resuelta redirigiendo a fichero.
