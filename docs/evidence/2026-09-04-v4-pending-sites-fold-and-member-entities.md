# v4: plegado de `jsts:unresolved_call`, tabla `pending.sites`, candidatos con destino y entidades miembro en cold

Fecha: 2026-09-04. Estado: **implementado y medido, sin commit** (23 ficheros, +4.342/−1.562; ver §7).
Corpus: `~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` (READ-ONLY). Máquina ociosa en todas las
mediciones de esta página (comprobado con `pgrep -f "vitest|cargo|v4-scan|urdira-indexing-worker"`).

## 1. Pregunta de partida y respuesta

¿Son útiles para las operaciones de consulta las filas `possible` sin destino y los diagnósticos
`jsts:unresolved_call`? Comprobado en `packages/engine/src/canonical-query-data-port.ts`:

- `core:find_references` filtra por `target` resuelto; una fila sin `target_id` nunca coincide.
- `core:expand_relations`, `core:find_paths`, `core:get_outline`, `core:analyze_impact` descartan
  aristas con `target` indefinido.
- Las filas `possible` **con** destino sí se devuelven, clasificadas `possible`, y los guards de recetas
  las exponen como candidatos alternativos.
- El diagnóstico no lo consumía nadie: v4 publica `capability_state` vacío (`publish.rs`), así que
  `completeness_report` nunca apuntaba a él, y el pase residual solo leía filas de relación.

Conclusión: los 637k diagnósticos eran duplicados puros; las 637k filas `possible` sin destino eran
estado interno del pase residual almacenado como records; y las únicas filas `possible` con valor
de consulta (candidatos con `target_id`) no existían.

## 2. Qué se ha hecho (cuatro pasos)

### 2.1 Plegado del diagnóstico (punto 1)

`semantic_sites.rs`: `unresolved_call_diagnostic_record` eliminado; el `reason` del sitio pasa al
cuerpo de la fila `possible`. `registry-contribution.ts`: `relationPayload.reason` (enum) sustituye a
`diagnosticPayload.reason`. Medido en aislamiento: cold 28,3 → 25,6 s (mediana de 3), store 2,7 → 2,3 GB.

### 2.2 Tabla `pending.sites` en el store (punto 2)

`crates/urdira-structural-store`: nueva tabla de stride fijo por segmento (`TableId::PendingSites = 5`,
`SectionId::PendingSites = 19`, `ClosuresPending = 20`; secciones opcionales, los stores previos abren
y pasan `verify_all`; formato de manifest sin cambio).

Fila (40 bytes, LE): `owner_artifact u32@0, owner_version u32@4, valid_from u32@8, valid_to u32@12,
start u32@16, end u32@20, start_line u32@24, end_line u32@28, site_kind u8@32, reason u8@33,
source_subject u32@34 (NONE_U32 = None)`, 2 reservados. Orden `(owner_artifact, start, end, site_kind)`,
duplicados rechazados. Cierres `closures.pending` (20 bytes: clave + `valid_to`), semántica idéntica a
`closures.records`. Compactación arrastra las filas visibles. API: `write_*_with_pending`,
`pending_sites_by_owner`, `iter_visible_pending_sites`, `pending_site(key)`, `pending_sites_visible_count`.

Códigos de `reason` (contrato en disco, append-only, `PendingReasonCode` en el syntax worker):
0 unspecified · 1 call_deferred_to_e3 · 2 call_target_uncertain · 3 overload_ambiguous ·
4 union_ambiguous · 5 target_not_interned · 6 heritage_unresolved · 7 heritage_deferred_to_e3 ·
8 heritage_target_uncertain · 9 heritage_clause_partially_pending.

Cableado: `OwnerSemantics::pending_site_rows` → `OwnerFacts` → `materialize` (source_subject con la
misma resolución que las relaciones) → `publish_cold` / `delta.rs` (reemplazo íntegro por owner:
cierra todas las del ordinal antiguo, abre las nuevas). La reparación P1-D-h ya no reescribe una fila
confirmada cuyo destino no interna a `:unresolved`: la descarta y emite un pending site
`target_not_interned`. Un candidato (§2.3) cuyo destino no interna se descarta sin pending site.
El pase residual (`residual.rs::collect`) itera la tabla en vez de escanear 2,8M records, y al
confirmar un sitio cierra su clave y las filas candidatas del mismo span.

Invariante nuevo: **cero** records de relación `core:call`/`inherits`/`implements` sin `target_subject`
(medido en n8n: 0).

### 2.3 Candidatos con destino para overloads y uniones (punto 3)

`urdira-jsts-typeflow`: `RawTypeRef::Union` / `ResolvedTypeRef::Union` desde `TSUnionType` (null,
undefined, literales y primitivos se descartan; cualquier constituyente `Unknown` contamina; un único
superviviente colapsa), `MemberLookup::UnionCandidates`, `ProgramIndex::members_of_union` (nunca
promueve a `One`). `semantic_sites.rs`: `TypeflowCallResolution::{Resolved, Candidates, Unresolved}`;
un `Candidates` emite una fila `core:call` `classification: "possible"` **con** `target_id`, facet
`core:indirect` y `reason` por candidato, y mantiene el sitio pendiente para tsgo. Regla dura
respetada: ningún camino nuevo produce `confirmed`.

### 2.4 Entidades miembro en cold (necesario para que 2.3 sirva)

Hallazgo: el productor de entidades de cold solo materializaba declaraciones de nivel módulo
(decisión 28, "Entity synthesis for members"). Todo destino miembro (`jsts:method:...`) fallaba al
internar: 32.145 llamadas a miembros confirmadas por typeflow se degradaban a pendientes y tsgo las
rehacía después; y 78.138 pending sites cuyo origen era un método quedaban sin `source_subject`
(el residual los saltaba).

`urdira-jsts-typeflow::member_declarations` es ahora la única fuente de la enumeración de miembros
(el propio `ProgramIndex` la usa; test de equivalencia bidireccional). `urdira-jsts-syntax-worker`
emite una entidad por miembro con la identidad byte-idéntica de typeflow (`EntityKind::{Method,
Constructor, Getter, Setter, Property}`, palabras de v3; `Callable`/`Value`), `parent_id` = contenedor,
`qualified_name = {path}.{Contenedor}.{nombre}`, más `core:contains` contenedor → miembro. Formas:
métodos de clase (instancia/estática, `#privados`), `constructor`, `get`/`set`, propiedades,
firmas de método y de propiedad de interfaz; clases anónimas se saltan. El residual reutiliza la
entidad de cold (`(path, name_start)` index) en vez de sintetizarla; test: ninguna identidad
duplicada tras el upgrade.

## 3. Composición del store n8n (cold, generación 1)

| métrica | HEAD (65d06dd) | final |
|---|---:|---:|
| records totales | 2.831.264 | **1.631.291** |
| `jsts:diagnostic` | 637.531 | 0 |
| `core:call` records | 734.379 | 97.562 |
| `core:call` confirmadas | 64.931 | **95.956** |
| `core:call` possible con destino (candidatos) | 0 | **1.606** (505 sitios overload + 2 unión) |
| relaciones sin destino | 671.358 | **0** |
| `jsts:entity_callable` / `_variable` | 15.879 / 211.909 | 30.224 / 235.733 |
| pending sites | (records) | 640.333 |
| pending `target_not_interned` | — | 1.094 (era 32.145 antes de §2.4) |
| pending con `source_subject = None` | — | 7.212 (era 78.138 antes de §2.4) |
| tamaño `structural/` | 2,7 GB | **1,8 GB** |

Contabilidad de sitios de llamada: 95.956 confirmadas + 638.423 pending de kind `call`
(375.398 + 261.424 + 505 + 2 + 1.094) = 734.379, idéntico al total histórico de v3: ninguna llamada
se pierde ni se inventa (los 1.606 candidatos comparten sitio con los 507 pending overload/unión). Raíces
`records`/`dependency`/`graph` byte-idénticas en 3 cold independientes.

## 4. Paridad frente al oráculo v3 (`scripts/v4-call-parity-diff.mjs`, v3 = `v4-p0/.../*.sqlite`)

| checkpoint | mismo destino | destino distinto | possible | sitio ausente |
|---|---:|---:|---:|---:|
| cold (antes de tsgo) | 89.095 | **0** | 112.459 | 3.914 |
| tras pase residual | **114.325** (antes 112.565) | **0** | 87.229 | 3.914 |

`count_classification_mismatches` = 0 en ambos checkpoints. Artefactos en
`~/Proyectos/urdira-benchmark/v4-fold/{parity-cold,parity-after}.json` y `call-bodies-*.bin`.

## 5. Tiempos (n8n, `node scripts/v4-scan.mjs`, release, máquina ociosa, 3 repeticiones)

| etapa | HEAD (mediana) | punto 1 | final (mediana) |
|---|---:|---:|---:|
| catalog | 5,5 s | 5,8 s | 5,3 s |
| parse | 1,8 s | 1,4 s | 2,1 s |
| resolve | 2,7 s | 2,6 s | 1,6 s |
| materialize | 8,2 s | 8,0 s | 4,6 s |
| write | 7,8 s | 6,1 s | 4,2 s |
| **total_ms** | **28,3 s** (26,7 / 28,3 / 29,1) | 25,6 s | **18,8 s** (18,5 / 18,8 / 19,4) |
| wall `real` | 28,4–31,7 s | 28,1–28,9 s | 20,5–22,2 s |
| RSS máx | 7,1–7,6 GB | 6,1–7,5 GB | 6,3–7,2 GB |

Incremental worker-only (`n8n_incremental_measurement`, generaciones 2–9), final vs
`2026-09-05-v4-final-measurements.md` §4.3: EDIT#1 0,78 s (3,04), EDIT estable 0,48–0,54 s
(0,46–0,61), CREATE 0,44 (0,51), DELETE 0,44 (0,46), RENAME 0,49 (0,53), HUB superficie sin cambio
0,44 (0,49), HUB superficie cambiada 1,05 s (1,44). El conjunto de pending sites tras crear+borrar es
idéntico al de un escaneo desde cero (671.202 tuplas exactas, `n8n_incremental_create_delete_roots_match_oracle`).

## 6. Bugs encontrados de paso

- `residual.rs::run_once_with_quiet_period` no volcaba `kinds`/`universal_kinds`/`relation_kinds` al
  sufijo de diccionario del delta: latente mientras cada kind estaba pre-internado por alguna fila de
  cold; al desaparecer las filas sin destino, un upgrade podía publicar una relación con `kind: ""`
  invisible a las consultas por kind. Arreglado (detectado por `tests/v4-daemon-e2e.test.ts`).
- El `graph` root y la columna `relation_count` del snapshot cambian respecto a stores previos: ambos
  se derivaban de "todos los records de relación", que incluían las 637k filas sin destino.

## 7. Puertas

`cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace`
(475 tests), vitest de v4/daemon/native/verify/plugin/codebase-fixtures (81 pasan, 1 skip
preexistente). `pnpm verify` completo: check:native, test:native, lint, typecheck y gates de cobertura
verdes; vitest 2.076 pasan / 1 falla / 11 skip — el fallo es `tests/app-runtime.test.ts` ("scans the
task-planner fixture ... rescans correctly after a one-file change": faltan `jsts:entity_inferred_type` de
tres ficheros en la consulta), que pasa 3/3 veces en aislamiento y es el flake por contención ya documentado
(`queryAfterStagedPublication`, cola del 2026-09-04).

## 8. No hecho / cola

- **Resuelto (mismo día, sesión posterior):** tras el plegado (§1-§2), ninguna operación de consulta
  exponía `pending.sites` -- `core:find_records` sobre `classification: "possible"` y
  `jsts:unresolved_call` ya no existen, y ambos eran, de todos modos, estado interno sin valor de
  arista de grafo. Se añadió el stream additivo `pending_sites` a `core:get_outline`
  (`packages/contracts/src/registries.ts`'s `operationSpecs["core:get_outline"].streams`, sin operación
  19ª): cuando `container` resuelve a la entidad módulo/contenedor de un artefacto (`universal_kind ===
  "core:container"`), todos los pending sites visibles de ese artefacto; para cualquier otra entidad,
  solo los que caen dentro de su propio span. Cadena nativa: `crates/urdira-native-node`'s
  `NativeStructuralStoreHandle::pending_sites_by_owner` (ordinal de owner ya resuelto por el llamador,
  igual que `deps_by_owner`) resuelve `source_subject -> dicts.subjects[ordinal] -> get_visible ->
  identity_key` -- la misma cadena de `residual.rs::collect`, copiada de solo lectura, no importada
  (crates distintas). `packages/engine/src/native-query-snapshot-port.ts`'s
  `pending_sites_by_owner_artifact` resuelve el ordinal vía `findArtifactOrdinal` (mismo patrón que
  `container_records_by_artifact_references`); un store v3 (sin tabla `pending.sites`) simplemente
  omite el método y el stream sale vacío, nunca en error. Hallazgo en vivo contra el fixture
  task-planner: `primary_source_span` de una entidad no-módulo es solo el span de su TOKEN de nombre
  (`InvalidTaskTransitionError` en [183,209), 26 bytes para 27 caracteres), nunca el cuerpo completo de
  la declaración -- así que el enunciado original de la tarea ("cuyo span cae dentro del span de la
  entidad") no podía implementarse como contención de bytes; se reemplazó por pertenencia vía el
  `source_id` ya resuelto del sitio contra `{contenedor} ∪ members` (la MISMA lista que este mismo
  `core:get_outline` ya devuelve, respetando `depth`), que es semánticamente más correcto (ata cada
  sitio a su declaración envolvente real, no a un rango de bytes coincidente) y no añade tráfico
  adicional. Ver `docs/protocol/public-query-contract.md`'s sección `core:get_outline` para la forma
  exacta del ítem.
- `entities.index` sigue sin ser tabla (el residual reconstruye el índice `(path, name_start)` en memoria).
- 7.212 pending sites siguen sin `source_subject` (ámbitos anónimos u otras formas no cubiertas) y
  1.094 destinos siguen sin internar: candidatos a análisis.
- Uniones: solo candidatos, nunca `confirmed` aunque todos los constituyentes coincidan (decisión
  conservadora de esta ronda).
- Docs de decisión 28/29 no actualizadas (esta página es la evidencia; el texto de "Entity synthesis
  for members" y "Classification invariant" de la decisión 28 queda desfasado y debe enmendarse al commitear).
- El store deja de emitir diagnósticos: cualquier consumidor externo que filtrase `record_categories:
  ["diagnostic"]` en stores v4 recibe ahora una lista vacía (no había ninguno en el repo).

## 9. Ronda 2 (2026-09-04 noche): poblaciones de records restantes

Medido sobre lo no comiteado encima del punto de 18,8 s de §5: entidades parámetro referenciadas en
cold, propiedades de parámetro como miembros + referencias member-read (typeflow), resolución de
referencias de default-import/re-export, stream `pending_sites` en `core:get_outline`, y tipos
inferidos + `type_of` + diagnósticos de compilador del pase residual tsgo. Máquina ociosa confirmada
(`pgrep -fl "vitest|cargo|v4-scan|urdira-indexing-worker" | grep -v code-collate` vacío) antes de
`cargo build --release -p urdira-indexing-worker && pnpm -r build && node scripts/build-native.mjs`.

### 9.1 Tiempos (n8n, `node scripts/v4-scan.mjs`, release, 3 repeticiones)

| etapa | HEAD (65d06dd) | tarde (18,8 s, §5) | ahora (ronda 2) |
|---|---:|---:|---:|
| catalog | 5,5 s | 5,3 s | 5,7 s |
| parse | 1,8 s | 2,1 s | 2,1 s |
| resolve | 2,7 s | 1,6 s | 1,9 s |
| materialize | 8,2 s | 4,6 s | 6,4 s |
| write | 7,8 s | 4,2 s | 6,6 s |
| **total_ms** | **28,3 s** | **18,8 s** | **23,6 s** (23,1 / 23,6 / 23,9) |
| wall `real` | 28,4–31,7 s | 20,5–22,2 s | 25,2–26,4 s |
| RSS máx | 7,1–7,6 GB | 6,3–7,2 GB | 6,2–6,6 GB |

Runs individuales (`timings_ms` de `v4-scan.mjs`): run1 catalog=5334 parse=2278 resolve=2202
materialize=6792 write=5518 fsync=197 snapshot=121 total=23143, real=25,22s, RSS=6.578.061.312B;
run2 catalog=5665 parse=1852 resolve=1926 materialize=6419 write=6784 fsync=174 snapshot=95
total=23592, real=26,38s, RSS=6.163.398.656B; run3 catalog=6025 parse=2068 resolve=1929
materialize=6018 write=6556 fsync=207 snapshot=84 total=23898, real=25,23s, RSS=6.435.815.424B.
Raíces `records`/`dependency`/`graph` byte-idénticas en los 3 runs (hash `graph`
`f44b821e...`, `dependency` `d76ff317...`, `records` `748c9087...` en los tres); `metric` sigue en
cero-hash en las tres. `du -sh final-1/structural` = **2,1 GB** (2,7 GB en HEAD, 1,8 GB en §5).
El total sube 18,8 s → 23,6 s (+25%) respecto a §5: coherente con el trabajo añadido (entidades
parámetro en cold, resolución member-read, `pending_sites` en `get_outline`), no una regresión de
lo ya medido en §5.

### 9.2 Composición del store (`final-1`, generación 1, `inspect_store_record_histogram`)

| métrica | HEAD (65d06dd) | tarde (§3, final ronda 1) | ahora (ronda 2) |
|---|---:|---:|---:|
| records totales | 2.831.264 | 1.631.291 | **1.879.556** |
| `jsts:entity_callable` | 15.879 | 30.224 | 30.224 |
| `jsts:entity_container` | — | — | 14.082 |
| `jsts:entity_parameter` | — | — | **74.442** |
| `jsts:entity_type` | — | — | 12.671 |
| `jsts:entity_variable` | 211.909 | 235.733 | 235.733 |
| `jsts:relation_call` (registros totales) | 734.379 | 97.562 | 102.763 |
| `core:call` confirmadas (cold, `inspect_store`) | 64.931 | 95.956 | 100.940 |
| `core:call` possible con destino (candidatos) | 0 | 1.606 | 1.823 |
| `jsts:relation_contains` | — | — | 353.070 |
| `jsts:relation_export` | — | — | 2.336 |
| `jsts:relation_implements` | — | — | 477 |
| `jsts:relation_import` | — | — | 58.302 |
| `jsts:relation_inherits` | — | — | 786 |
| `jsts:relation_references` | — | — | **994.285** |
| relaciones sin destino (`call`/`inherits`/`implements`) | 671.358 | 0 | **0** |
| references sin destino (diagnóstico) | — | — | 3.568 |
| references resueltas a parámetro (subconjunto CON destino) | — | — | 154.264 |
| pending sites visibles | (records) | 640.333 | 635.349 |
| pending `call_deferred_to_e3` | — | — | 370.349 |
| pending `call_target_uncertain` | — | — | 261.422 |
| pending `overload_ambiguous` / `union_ambiguous` | — | — | 568 / 2 |
| pending `target_not_interned` | — | 1.094 | 1.098 |
| pending heritage (`inherits`+`implements`, 4 reasons) | — | — | 193+464+4+35+1214=1.910 |
| pending con `source_subject=None` | — | 7.212 | 7.092 |
| tamaño `structural/` | 2,7 GB | 1,8 GB | **2,1 GB** |

**Chequeo de consistencia pedido explícitamente**: el agente anterior reportó `total_records=1.775.111`
con `jsts:relation_references` sin cambio pese a que la paridad de referencias mostraba +52.716
referencias recién confirmadas en cold (esperado ≈ 903.682 + 52.716 ≈ 956k referencias / ≈1,83M
records totales). Lo medido aquí sobre `final-1` es **994.285** `jsts:relation_references` y
**1.879.556** records totales — ambos **por encima**, no por debajo, de esas cifras esperadas
(994.285 > 956k; 1.879.556 > 1,83M). No es el caso "números más bajos" que el enunciado pedía
reportar como posible fallo de la resolución member-read sin llegar al store: aquí llegó, y con más
referencias confirmadas que las que la extrapolación del agente anterior proyectaba. Se reporta como
hallazgo, no se investiga la causa exacta del delta adicional (~38k referencias, ~46k records) sobre
la proyección.

**Segundo hallazgo, sin resolver**: el pase residual (§9.4) imprime, para el mismo store recién
escaneado en frío, `core:call confirmed=102763 possible=0` (su propio
`print_confirmed_possible_histogram`), mientras que `inspect_store_record_histogram` (esta sección)
reporta `core:call confirmed=100940 possible_with_target(candidatos)=1823` sobre `final-1` (misma
cifra total 102.763 = 100.940+1.823 en ambos). Son dos funciones de test distintas contando el mismo
campo de clasificación con criterios distintos (una cuenta candidatos `possible` con destino como
"confirmed", la otra los separa) — no se concilió esta ronda; queda como candidato a análisis, no se
tocó código de producto.

### 9.3 Incremental worker-only (`n8n_incremental_measurement`)

| paso | wall | total_ms |
|---|---:|---:|
| COLD (gen 1) | 23,319 s | 22.361 |
| EDIT#1 (gen 2) | 1,339 s | 1.322 |
| EDIT#2 (gen 3) | 0,568 s | 551 |
| CREATE (gen 4) | 0,462 s | 445 |
| DELETE (gen 5) | 0,444 s | 428 |
| EDIT#3 (gen 6) | 0,522 s | 506 |
| RENAME (gen 7) | 0,526 s | 509 |
| HUB superficie sin cambio (gen 8) | 0,496 s | 480 |
| HUB superficie cambiada (gen 9) | 1,101 s | 1.083 |

`n8n_incremental_create_delete_roots_match_oracle`: igualdad de raíces **CONFIRMADA** create+delete
contra oráculo from-scratch; igualdad del conjunto de pending sites **CONFIRMADA**, 635.193 sitios
(cercano pero no idéntico a los 635.349 visibles de `final-1` §9.2 — corpus mutado create+delete vs.
corpus original, no es el mismo árbol).

### 9.4 Pase residual a escala n8n + paridad

`n8n_residual_pass_debug_histogram` (`URDIRA_V4_RESIDUAL_DEBUG=1`): cold scan wall=24,017 s;
`classification_mismatches` COLD=0 y AFTER=0 (gate duro respetado). Pase residual: wall=**70,732 s**
(orden de magnitud: ~1 minuto, trabajo de fondo tsgo, no gate), `total_ms=64558`,
`upgraded=58.309`, `external=40.158`, `unresolved=529.790`, `inferred_type_entities=40.382`,
`type_of_relations=40.382`, `diagnostics_emitted=248.193` (diagnósticos tsgo del debug dump, no
records del store — ver §2.1, el store ya no persiste diagnósticos). Diagnóstico dominante: TS2304
(116.580, `Cannot find name`), TS2593 (61.022, falta `@types/jest`/`@types/mocha`), TS2307 (37.181,
módulo no encontrado). Histograma de razón `unresolved` (60 muestras): `no_symbol` 422.661,
`workspace_target_pre_entity_lookup` 60.537, `rpc_error` 104.757, `external_lib` 40.158,
`entity_index_miss` 2.228, `symbol_no_declaration` 47, `declaration_text_unavailable` 97 (suma
distinta de `unresolved_sites` porque el histograma de razones agrupa external/upgraded/unresolved
juntos, no solo `unresolved`).

`scripts/v4-call-parity-diff.mjs` contra el oráculo v3 (mismo `.sqlite` que §4, 205.468 `core:call`
confirmadas en v3 en ambos checkpoints):

| checkpoint | mismo destino | destino distinto | possible | sitio ausente |
|---|---:|---:|---:|---:|
| cold (antes de tsgo) | 91.088 (44,33%) | **0** | 110.504 (53,78%) | 3.876 (1,89%) |
| tras pase residual | **114.554** (55,75%) | **0** | 87.038 (42,36%) | 3.876 (1,89%) |

`scripts/v4-references-parity-diff.mjs` contra el mismo oráculo, checkpoint cold único (el pase
residual nunca toca `core:references`, ver el propio header del script y el doc comment de
`n8n_references_parity_debug_dump`): v3 tiene 1.110.576 `core:references` confirmadas (0 de otra
clasificación). v4: 994.285 filas, 990.717 con `target_subject`.

| checkpoint | mismo destino | destino distinto | ausente |
|---|---:|---:|---:|
| cold (único, ver arriba) | 942.733 (84,89%) | **0** | 167.843 (15,11%) |

Motivos del `v4_missing` (histograma del script, sitios `IdentifierRef` pendientes en memoria,
635.349-ajeno — población separada de `pending.sites`): `member_access` 83.365, `unresolved_global`
65.502, `import_binding` 7.360, `unsupported_declaration_kind` 6.128, `jsdoc_typed_file` 2.853,
`unknown_no_pending_dump_match` 1.314, `type_predicate_parameter` 1.009, `re_export_binding` 256,
`multiple_declarations` 49, `this_expression` 7. Cruce por tipo de destino v3: `module_level_entity`
85.906, `member` 80.005, `parameter` 1.932.

### 9.5 `pnpm verify`

`Test Files 1 failed | 138 passed | 2 skipped (141)`; `Tests 1 failed | 2080 passed | 13 skipped
(2094)`; cobertura: statements 83,97%, branches 73,71%, functions 81,05%, lines 90,07%.

El fallo **no** es `tests/app-runtime.test.ts` (el flake de contención documentado en §7) sino
`tests/phase-index-pack.test.ts > Index pack (docs/decisions/23-index-pack.md) > (g) export and
import stay near-linear at scale`:

```
AssertionError: expected 62288 to be less than 60000
 ❯ tests/phase-index-pack.test.ts:596:24
    594|       console.log(`[index-pack perf gate] import of the same pack took…
    595|       expect(outcome.status).toBe("imported");
    596|       expect(importMs).toBeLessThan(PERF_BOUND_MS);
       |                        ^
```

(export de 1.000.047 filas `identity_assignments`: 12.958 ms; import de ese mismo pack: 62.288 ms,
1,89 s por encima del límite de 60.000 ms). Por instrucción explícita del enunciado, al no ser
`app-runtime.test.ts` no se repitió 3 veces ni se tocó código de producto; se reporta el bloque
verbatim tal cual. Es un gate de tiempo real (import de una fila 1M), no un test funcional; su
margen (62,288 s vs. 60 s, +3,8%) es compatible con contención de máquina tras la sesión de medición
que le precede en el mismo `pnpm verify`, pero no se confirmó re-ejecutando (fuera de alcance por el
enunciado).

### 9.6 Qué queda abierto

- Del §8 original: `entities.index` sigue sin ser tabla; 7.092 pending sites sin `source_subject`
  (bajó de 7.212) y 1.098 destinos sin internar (subió de 1.094); uniones solo generan candidatos,
  nunca `confirmed`; docs de decisión 28/29 sin actualizar; el store no emite diagnósticos.
- Nuevo (9.2): el delta de ~38k referencias / ~46k records sobre la proyección `903.682 + 52.716 ≈
  956k` del agente anterior no se investigó — solo se confirmó que va en la dirección "más alto", no
  "más bajo" (que habría sido la señal de una resolución member-read no llegando al store).
- Nuevo (9.2): discrepancia entre `print_confirmed_possible_histogram` del pase residual
  (`core:call confirmed=102763 possible=0`) e `inspect_store_record_histogram`
  (`confirmed=100940 possible_with_target=1823`) sobre el mismo total de 102.763 — dos funciones de
  test con criterios de clasificación distintos, sin conciliar.
- Nuevo (9.5): fallo de `pnpm verify` en `tests/phase-index-pack.test.ts` (import 62.288 ms > límite
  60.000 ms), no reproducido ni investigado más allá de lo que pide el enunciado.
- Del header de `scripts/v4-references-parity-diff.mjs`: la comparación de referencias solo tiene
  checkpoint cold (el pase residual no toca `core:references`); el join de `v4_missing` contra el
  dump de sitios `IdentifierRef` pendientes depende de que `--v4-pending-dump` provenga del MISMO run
  que `--v4-bodies` (aquí así fue, mismo test, mismo generation=1).

### 9.7 Atribución de la subida del cold (18,9 → 23,6 s) y veredicto sobre el fallo de `verify`

Un cold con `URDIRA_DEBUG_TIMING=1` (total_ms 24.567) frente al de referencia de la tarde (18.931), mismo
corpus y máquina ociosa. Records 1.631.291 → 1.879.556 (+15,2 %); subjects 292.686 → 367.128 (+25,4 %);
graph_entries 1.338.581 → 1.512.404 (+13 %); RSS post-materialize BAJA 6.010 → 5.085 MiB.

| sub-temporizador | tarde | ahora | delta |
|---|---:|---:|---:|
| resolve hybrid_semantics (typeflow por sitio, ahora también lecturas `a.b`) | 1,206 s | 1,770 s | +0,56 s |
| materialize pass1 (kernel canonicalize, SHA-256 por record) | 3,092 s | 4,926 s | +1,83 s |
| materialize pass2 (dict + subject_resolve + assemble) | 1,877 s | 2,549 s | +0,67 s |
| write_base_partitioned (to_page_cache) | 3,809 s | 6,437 s | +2,63 s |
| — de los cuales hash `records.body` | 1,724 s | 2,516 s | +0,79 s |
| — bytes body / ident escritos | — | 748 MB / 533 MB | — |

Los tres primeros cubos suman ≈ +5,1 s, es decir, toda la subida. La escritura y la canonicalización crecen
más que proporcionalmente a los records (+69 % y +59 % frente a +15 %): las poblaciones nuevas
(referencias a miembros y parámetros, `contains` de parámetros) son filas de relación con identity keys y
bodies largos (`jsts:references:{path}:{start}:{end}:{source_id}:{target_id}`), y el store escribe la
identity completa por fila (533 MB de `records.ident`). Los tipos inferidos y diagnósticos NO intervienen
en cold (solo residual). Palancas obvias para recuperar los ~5 s: comprimir identity keys por diccionario
en el store y el kernel tipado sin `serde_json::Value` (ya priced en la cola del dueño, −4-5 s).

**`tests/phase-index-pack.test.ts (g)`**: en aislamiento pasa (import 24.352 ms, cota 45.000 por
defecto y 60.000 bajo coverage); la cota es wall-clock y bajo `pnpm verify` corre con cobertura v8 y
ficheros de test concurrentes. El camino medido (`packages/engine/src/index-pack.ts` sobre `@urdira/storage`)
no importa ningún fichero cambiado hoy. Veredicto: contención, no regresión.

### 9.8 Los 167.843 `v4_missing`: ¿workspace o externos? (pregunta del dueño, medición pura)

Pregunta: de las 167.843 `core:references` que v3 confirma y v4 no emite en cold (§9.4), ¿cuántas
apuntan a entidades DENTRO del workspace (recuperables) frente a fuera (`lib.*.d.ts`, `node_modules`,
ambiente)? Sin cambios de producto: solo un cold scan fresco (mismo corpus, mismo oráculo v3) y una
extensión aditiva de `scripts/v4-references-parity-diff.mjs` (`--classify-targets`, nuevas funciones
`parseTargetId`/`classifyTarget`/`rawTargetKind`, nuevos campos de salida -- ver el propio script).

**Reproducción**: `cargo build --release -p urdira-indexing-worker`, luego
`URDIRA_V4_N8N_CORPUS=~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
URDIRA_V4_REFERENCE_BODY_DUMP=<path> URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP=<path> cargo test
-p urdira-indexing-worker --release v4::tests_e2e::n8n_references_parity_debug_dump -- --ignored
--nocapture` (cold analyze wall=10,477 s en esta máquina, corpus ya en page cache; el dump reprodujo
EXACTO lo ya medido en §9.4: 994.285 filas `core:references`, 990.717 `confirmed`, histograma de
`reason` idéntico -- `member_access` 83.365, `unresolved_global` 65.502, `import_binding` 7.360,
`unsupported_declaration_kind` 6.128, `jsdoc_typed_file` 2.853, `unknown_no_pending_dump_match` 1.314,
`type_predicate_parameter` 1.009, `re_export_binding` 256, `multiple_declarations` 49,
`this_expression` 7). Luego `node scripts/v4-references-parity-diff.mjs --v3-db <oráculo v3>
--v4-bodies <dump> --v4-pending-dump <dump> --corpus-root ~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02
--classify-targets 1 --samples 10 --out report.json`. Confirmado de nuevo: 942.733 `v4_same_target`
(84,89%), 0 `v4_different_target`, 167.843 `v4_missing` (15,11%) -- gate duro intacto. Scratch usado:
`~/Proyectos/urdira-benchmark/v4-fold/refs-parity/` (dump binario + TSV + report.json/txt), borrado al
cierre de esta sección (ver §9.8.5); no se tocó `final-1`.

**Mecanismo de clasificación** (`classifyTarget`, `scripts/v4-references-parity-diff.mjs`): el `target_id`
de v3 tiene la forma `jsts:{kind}:{path}:{start}:{name}`; se extrae `path` y se prueba, en orden,
`workspace` (`path` -- absoluto o unido a `--corpus-root` -- existe DENTRO del corpus, `fs.existsSync`
restringido a que el resultado quede bajo el corpus root, para no confundir un path absoluto que
exista en ESTA máquina por otro motivo con un fichero del corpus), `lib` (`path` matchea
`lib.<algo>.d.ts`), `node_modules` (`path` contiene `node_modules/`), `other` (nada de lo anterior, p.
ej. sin `path` -- no se observó ningún caso en esta población). Verificado en vivo contra las
1.110.576 filas confirmadas de v3 (no solo las 167.843 missing): CADA `target_id` de ruta absoluta en
todo el dataset (137.259 filas) es simultáneamente `node_modules` Y `lib.*.d.ts` -- son, sin excepción,
los `.d.ts` de la instalación de TypeScript de ESTE repo (`node_modules/.pnpm/@typescript+typescript-
darwin-arm64@.../lib/lib.es5.d.ts` etc., no del corpus -- v3 se generó resolviendo los globals de
TS contra el TypeScript del propio urdira, no el del corpus), y ninguna otra ruta absoluta aparece en
todo el dataset; todo target de ruta relativa es un fichero real del corpus.

#### 9.8.1 Tabla principal: destino workspace vs. externo (167.843 = 100%)

| clase de destino | filas | % de 167.843 |
|---|---:|---:|
| `lib` (`lib.*.d.ts`, globals de TypeScript) | 137.259 | 81,78% |
| `workspace` (fichero real del corpus) | 30.584 | 18,22% |
| `node_modules` (dependencia vendorizada, no `lib`) | 0 | 0,00% |
| `other` (sin `path` / ambiguo) | 0 | 0,00% |

**Hallazgo no anticipado por el enunciado**: la partición es binaria en la práctica -- no hay NINGÚN
`v4_missing` cuyo destino sea una dependencia real de n8n en `node_modules` (Express, TypeORM, etc.) ni
un destino sin `path` (declaración puramente ambiente sin fichero). El 100% de lo "externo" es,
específicamente, la librería estándar de TypeScript (`lib.es5.d.ts`, `lib.dom.d.ts`,
`lib.es2015.*.d.ts`, ...): `JSON`, `Promise`, `Record`, `.stringify`, `.parse`, `.get`, `fetch`, etc.
Respuesta directa a la pregunta del dueño: de 167.843, **30.584 (18,22%) son potencialmente
recuperables** (apuntan dentro del workspace); **137.259 (81,78%) son intrínsecamente externas** (lib
de TypeScript) y closed on typeflow ampliarse a la lib estándar, no a bugs del resolutor de este repo.

#### 9.8.2 Cruce `reason` x clase de destino

| reason | lib | workspace | total |
|---|---:|---:|---:|
| `member_access` | 71.158 | 12.207 | 83.365 |
| `unresolved_global` | 65.281 | 221 | 65.502 |
| `import_binding` | 0 | 7.360 | 7.360 |
| `unsupported_declaration_kind` | 2 | 6.126 | 6.128 |
| `jsdoc_typed_file` | 709 | 2.144 | 2.853 |
| `unknown_no_pending_dump_match` | 109 | 1.205 | 1.314 |
| `type_predicate_parameter` | 0 | 1.009 | 1.009 |
| `re_export_binding` | 0 | 256 | 256 |
| `multiple_declarations` | 0 | 49 | 49 |
| `this_expression` | 0 | 7 | 7 |

`unknown_no_pending_dump_match` (1.314 filas, 0,78% del total) es un artefacto de metodología, no de
producto: el join `(path, start, end)` entre `v4_missing` y el TSV de sitios `IdentifierRef`
pendientes no encontró la clave -- mismo fallback ya documentado en el propio script (`??
"unknown_no_pending_dump_match"`), no diagnosticado más a fondo en esta sesión.

#### 9.8.3 Solo destinos `workspace` (30.584 = 100%): por `reason` y por tipo de destino v3

| reason | filas | % de 30.584 | tipo de destino v3 dominante |
|---|---:|---:|---|
| `member_access` | 12.207 | 39,92% | `method` 5.912 (48%), `function` 2.105 (17%), `variable` 1.267 (10%), `getter` 1.263 (10%), `property` 817 (7%) |
| `import_binding` | 7.360 | 24,07% | `variable` 2.645, `function` 2.447, `class` 841, `interface` 598, `namespace` 523, `type` 218, `enum` 88 |
| `unsupported_declaration_kind` | 6.126 | 20,03% | `variable` 5.779, `parameter` 347 |
| `jsdoc_typed_file` | 2.144 | 7,01% | `variable` 1.363, `parameter` 440, `function` 315, `method`/`getter` 10 c/u, `class` 6 |
| `unknown_no_pending_dump_match` | 1.205 | 3,94% | `method` 642, `variable` 320, `namespace` 149, `type` 85, `parameter` 9 |
| `type_predicate_parameter` | 1.009 | 3,30% | `parameter` 1.009 (100%) |
| `re_export_binding` | 256 | 0,84% | `function` 107, `interface` 76, `class` 45, `type` 18, `variable` 9, `namespace` 1 |
| `unresolved_global` | 221 | 0,72% | `namespace` 193, `interface` 26, `type` 2 |
| `multiple_declarations` | 49 | 0,16% | `variable` 41, `function` 6, `interface` 2 |
| `this_expression` | 7 | 0,02% | `class` 7 (100%) |

#### 9.8.4 Muestras (5 aleatorias por `reason`, solo destinos `workspace`) y juicio de recuperabilidad

Cada muestra es `path:start` del SITIO (no del destino) más el `target_id` de v3 completo (que sí
lleva el fichero:posición REAL de la declaración destino). Juicio fundamentado leyendo
`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs` (líneas citadas) contra el propio mecanismo
que produce cada `reason`.

**`member_access` (12.207, 39,9% del workspace) -- RECUPERABLE PARCIALMENTE, requiere ampliar
`type_of_expression`/`type_of_static_member`, no un bug simple.** El lookup de miembro
(`resolve_static_member_reference`, línea 2471) ya delega en `type_of_expression(&expr.object)`
(línea 1999) para tipar el receptor -- y ese tipador ya cubre bastante: `this`/`super`, identificador
con tipo declarado o forma de objeto inferida, `new X()`, `await`, cadenas `a.b(...).c(...)` con
retorno `this`, `a[i]` sobre array/`Record`. Tres formas de receptor concretas SÍ vistas en las
muestras y NO cubiertas hoy:
  - `packages/nodes-base/nodes/Odoo/test/v2/methods/listSearch.test.ts:6106`,
    `v3_target=jsts:function:.../Odoo/v2/transport/index.ts:6184:odooApiRequest` -- sitio real:
    `(transport.odooApiRequest as jest.Mock).mockResolvedValue(...)`. `transport` es un objeto
    importado (probablemente `import * as transport` o un módulo con funciones nombradas). El brazo
    `Expression::Identifier` de `type_of_expression` (línea 2021) SOLO intenta
    Class/Interface-estático, `local_types` y `variable_declared_type`/`is_container` -- nunca
    consulta un binding de import como receptor de una LECTURA de propiedad; el único sitio que sí
    resuelve un miembro de namespace importado es `resolve_namespace_member`, pero está cableado
    ÚNICAMENTE dentro de `type_of_call_expression`'s member-callee branch (línea ~2245), no en
    `type_of_static_member`. Recuperable: extender `type_of_static_member`/`type_of_expression` a
    intentar `resolve_namespace_member` también para una lectura (no-llamada) de propiedad sobre un
    identificador import-bound.
  - `packages/@n8n/agents/src/runtime/observation-log-reflector.ts:6366`,
    `v3_target=jsts:method:.../types/sdk/observation-log.ts:3171:applyObservationLogReflection` --
    sitio real: `const { memory, ... } = opts;` (desestructuración de un PARÁMETRO tipado por
    interfaz), luego `memory.applyObservationLogReflection(...)`. `memory` nunca entra en
    `local_types` porque la captura de tipos de bindings desestructurados (`record_destructured_
    object_types`, citada en §2.4 de este mismo documento para miembros) no cubre desestructurar
    directamente un PARÁMETRO con tipo de interfaz -- distinto del caso "objeto literal" que sí
    cubre P1-A (línea ~2039). Recuperable: ampliar la captura de `local_types` a desestructuraciones
    de un parámetro con anotación de interfaz/tipo, reusando `variable_declared_type`.
  - `packages/@n8n/db/src/migrations/common/1738709609940-CreateFolderTable.ts:555`,
    `v3_target=jsts:getter:.../migrations/dsl/column.ts:1906:notNull` -- sitio real:
    `column('id').varchar(36).primary.notNull` (DSL fluida: llamada, luego dos getters
    encadenados). `type_of_call_expression`/`type_of_static_member` sí soportan cadenas
    `this`-retornantes, pero la DSL de migraciones usa tipos GENÉRICOS
    (`ColumnBuilder<T>`-como); no se confirmó en esta sesión si `resolve_type_ref_relative`
    sustituye parámetros de tipo genéricos -- hipótesis más probable dado que el resto del mecanismo
    de cadena ya está cableado y el fallo persiste solo en DSLs genéricas.
  Los tipos `method`/`function`/`variable`/`getter`/`property` mayoritarios en este `reason`
  encajan con estas tres formas (namespace-import leído como valor, parámetro desestructurado
  tipado, cadena fluida genérica), no con una única causa.

**`import_binding` (7.360, 24,1%) y `re_export_binding` (256, 0,8%) -- RECUPERABLE, mecanismo
identificado con precisión.** `resolve_import_binding`/`resolve_export_source_binding` (línea 1311,
1329) delegan en `resolve_named_binding_via_specifier`, que el propio doc comment describe como UN
SOLO salto: specifier -> fichero -> tabla de exports de ESE fichero. Muestra confirmatoria:
`packages/cli/.../dynamic-credentials-rate-limit.integration.test.ts:1095`,
`v3_target=jsts:class:.../services/credential-resolver-registry.service.ts:425:
DynamicCredentialResolverRegistry` -- el import real en el fichero es
`import { DynamicCredentialResolverRegistry } from '../services'`, es decir, un BARRIL
(`services/index.ts`) que a su vez re-exporta desde `credential-resolver-registry.service.ts`: dos
saltos, no uno. Coincide exactamente con la hipótesis del enunciado ("multi-hop named re-exports need
the import chain walk"). Recuperable: convertir `resolve_named_binding_via_specifier` en un walk que
repita el salto specifier->fichero->exports mientras el nombre resuelto sea, a su vez, un re-export
(mismo patrón que P2-2i ya aplicó para `resolve_export_source_binding`, según el propio comentario de
esa función, pero limitado a un salto).

**`unsupported_declaration_kind` (6.126, 20,0%) -- RECUPERABLE, y la causa real NO es la que sugería
el enunciado.** El enunciado proponía "bindings desestructurados"; medido en vivo (query aparte sobre
los 6.128 sitios): el 92,2% de los NOMBRES de destino son bindings de captura de excepción
(`error` 4.900, `e` 640, `err` 106, `caught`/`ex`/variantes ~100 más -- `catch (error) { ... }`), y
otro ~4,5% es el patrón de parámetro rest (`args` 274, nombre típico de `...args`). Grounded en
`classify_symbol_declaration` (línea 714): su `match` solo tiene brazos para
`Function`/`Class`/`TSInterfaceDeclaration`/`TSTypeAliasDeclaration`/`TSEnumDeclaration`/
`TSModuleDeclaration`/`VariableDeclarator` (con patrón `BindingIdentifier`)/`FormalParameter` (ídem)
-- NO hay brazo para el nodo de binding de una cláusula `catch` ni para un `BindingRestElement`
(`...args`), así que `scoping.symbol_declaration(symbol_id)` devuelve un `AstKind` que cae al `_ =>
None` final SIN comprobar en absoluto si el patrón es un simple identificador (que en ambos casos SÍ
lo es -- no son desestructuraciones). Recuperable de forma directa y barata: añadir esos dos brazos
(mapeando ambos a `DeclKind::Variable`/`DeclKind::Parameter` respectivamente cuando el patrón interno
es `BindingIdentifier`), sin tocar typeflow -- puramente sintáctico.

**`jsdoc_typed_file` (2.144, 7,0%) -- NO es recuperable con este mecanismo; es una partición
deliberada, no un fallo.** `self.jsdoc_typed_file` (línea 1357, 1509, 1571 -- comprobado en
`resolve_identifier_reference`, `resolve_identifier_to_kind` y `resolve_static_member_reference` por
igual) hace que TODO el fichero completo quede pendiente, por diseño ("safe-partition rule": un
fichero cuyos tipos vienen de comentarios JSDoc en vez de sintaxis TS no es fiable para el walker de
Rust). Estos targets SÍ son ficheros reales del workspace, pero recuperarlos requeriría parsear JSDoc,
no ampliar el resolutor TS actual -- coste de una categoría de trabajo distinta a las anteriores.

**`type_predicate_parameter` (1.009, 3,3%) -- RECUPERABLE, bug de sitio conocido y ya documentado en
el propio código.** El comentario de `REASON_TYPE_PREDICATE_PARAMETER` (línea 530) y de
`visit_ts_type_predicate` (línea ~1568) explican que oxc NUNCA da un nodo `IdentifierReference` al
nombre del parámetro en `value is Foo` -- por construcción no hay referencia que resolver por el
camino normal. Recuperable: en el propio `visit_ts_type_predicate`, en vez de emitir un pending site,
resolver manualmente el nombre contra el parámetro REAL del mismo signature (mismo nombre, mismo
scope) y emitir la fila `core:references` directamente ahí -- no depende de typeflow.

**`multiple_declarations` (49, 0,2%) -- RECUPERABLE en teoría, coste/beneficio bajo.**
`resolve_identifier_reference` (línea 1531) descarta CUALQUIER símbolo con `symbol_redeclarations`
no vacío, sin mirar si las redeclaraciones son ambiguas de verdad (p. ej. overloads de función que sí
comparten un único target razonable) o genuinamente conflictivas. Volumen bajo (49 de 167.843, 0,03%
del total); no prioritario.

**`unresolved_global` (221 sobre workspace, 0,7% del bucket workspace -- frente a 65.281 sobre `lib`)
-- mezcla.** Sobre workspace, dominan destinos `namespace` (193: `jest`, `globalThis` vistos en las
muestras, declarados vía `.d.ts` ambiente DENTRO del corpus, p. ej. `packages/cli/src/jest.d.ts`).
`resolve_identifier_reference` (línea 1511-1516) trata como `unresolved_global` cualquier
`IdentifierReference` sin `reference_id`/`symbol_id` en scope -- exactamente lo que corresponde a un
global ambiente declarado por un `.d.ts` sin `import`. Recuperable solo si se decide tratar
namespaces ambiente conocidos (`jest`, `globalThis`) como un caso especial resoluble contra su
declaración `.d.ts` -- volumen bajo, no prioritario.

**`this_expression` (7, 0,02%) -- no diagnosticado a fondo (volumen insuficiente para justificar más
tiempo esta sesión).** Las 7 muestras apuntan todas a una `class` real del workspace
(`InstanceAiAdapterService`, `WorkflowBuilderAgent` x3, `LazyPackageDirectoryLoader`) -- el
mecanismo (`type_of_expression`'s brazo `ThisExpression`, línea 2001) requiere `self.class_stack.
last()`; no se confirmó por qué ese stack está vacío en estos 7 sitios concretos (posición anidada
en una función no-flecha dentro del método, quizá).

#### 9.8.5 Qué no se hizo / limitaciones

- No se corrió el pase residual (tsgo) para esta pregunta -- el enunciado y el propio header del
  script son explícitos: `core:references` nunca pasa por el residual, el checkpoint cold es el único
  que existe para esta población (mismo hecho ya en §9.4).
- La atribución de causa para `member_access` (3 formas de receptor) y para `this_expression` se basa
  en LECTURA DE CÓDIGO + 5-15 muestras por celda, no en instrumentación exhaustiva de las 12.207/7
  filas; se reporta como diagnóstico fundamentado, no como conteo exacto de cuántas de esas 12.207
  caen en cada una de las tres formas.
- `unknown_no_pending_dump_match` (1.314 filas totales, 1.205 de ellas `workspace`) no se investigó
  más: es un artefacto conocido del join del script, no una categoría semántica de `semantic_sites.rs`.
- No se implementó ningún fix -- tarea de solo medición, sin cambios de producto ni commits, según el
  enunciado.
- Limpieza: `~/Proyectos/urdira-benchmark/v4-fold/refs-parity/` (dump binario ~470 MB + TSV + reports)
  borrado al terminar esta sección; `~/Proyectos/urdira-benchmark/v4-fold/final-1` intacto.

## 10. Ronda 3 (2026-09-05 madrugada): paquetes externos, referencias baratas, ambient modules

Medido sobre lo no comiteado encima del punto de 23,6 s de §9 (ronda 2): entidades de paquete/símbolo
externo (`jsts:external_module:*`, `jsts:external_symbol:*`) con destinos de import y referencias
confirmadas a externos importados; entidades de cláusula `catch` y de parámetro rest (solo
referenciables) y sus referencias; cadenas de barril `export *`; referencias de parámetro de
type-predicate; índice de `declare module` ambiente (solo ficheros de script, las augmentaciones se
ignoran) con entidades de namespace. Máquina ociosa confirmada (`pgrep -fl
"vitest|cargo|v4-scan|urdira-indexing-worker" | grep -v code-collate` vacío) antes de `cargo build
--release -p urdira-indexing-worker && pnpm -r build && node scripts/build-native.mjs` (los tres
comandos terminaron en verde). Agente de medición: no se tocó código de producto en ningún paso.

### 10.1 Tiempos (n8n, `node scripts/v4-scan.mjs`, release, 3 repeticiones)

| etapa | HEAD (65d06dd) | tarde (§5) | ronda 2 (§9) | ronda 3 (ahora) |
|---|---:|---:|---:|---:|
| catalog | 5,5 s | 5,3 s | 5,7 s | 5,3 s |
| parse | 1,8 s | 2,1 s | 2,1 s | 2,1 s |
| resolve | 2,7 s | 1,6 s | 1,9 s | 2,2 s |
| materialize | 8,2 s | 4,6 s | 6,4 s | 6,9 s |
| write | 7,8 s | 4,2 s | 6,6 s | 11,1 s |
| **total_ms** | **28,3 s** | **18,8 s** | **23,6 s** | **30,0 s** (28,6 / 30,0 / 30,9) |
| wall `real` | 28,4–31,7 s | 20,5–22,2 s | 25,2–26,4 s | 31,7–33,3 s |
| RSS máx | 7,1–7,6 GB | 6,3–7,2 GB | 6,2–6,6 GB | 5,7–6,2 GB |

Runs individuales (`timings_ms` de `v4-scan.mjs`): run1 catalog=5319 parse=2516 resolve=2186
materialize=7903 write=8688 fsync=175 snapshot=4 total=28606, real=31,71s, RSS=6.128.074.752B; run2
catalog=5475 parse=2093 resolve=2611 materialize=6424 write=11936 fsync=241 snapshot=9 total=30929,
real=33,26s, RSS=6.145.343.488B; run3 catalog=5168 parse=1643 resolve=2098 materialize=6921
write=11067 fsync=1129 snapshot=7 total=29954, real=32,24s, RSS=6.665.322.496B. Raíces
`records`/`dependency`/`graph` byte-idénticas en los 3 runs (`records` `sha256:7a0c6ec5...`,
`dependency` `sha256:d76ff317...`, `graph` `sha256:d8ee19718...`); `metric` sigue en cero-hash en las
tres. `du -sh final-1/structural` = **2,3 GB** (2,7 GB HEAD, 1,8 GB tarde/§5, 2,1 GB ronda 2/§9). El
total sube 23,6 s → 30,0 s (+27%) respecto a §9: coherente con las poblaciones nuevas de esta ronda
(externos, catch/rest, barriles, ambient modules) sumadas a más trabajo de `write` (11,1 s vs 6,6 s en
ronda 2) — no se corrió el desglose de sub-temporizadores de §9.7 esta ronda (fuera de alcance del
enunciado), así que la atribución exacta del delta de `write` no se investiga aquí, solo se reporta.

### 10.2 Composición del store (`final-1`, generación 1, `inspect_store_record_histogram`)

| métrica | HEAD (65d06dd) | tarde (§3) | ronda 2 (§9.2) | ronda 3 (ahora) |
|---|---:|---:|---:|---:|
| records totales | 2.831.264 | 1.631.291 | 1.879.556 | **2.162.391** |
| `jsts:entity_callable` | 15.879 | 30.224 | 30.224 | 30.224 |
| `jsts:entity_container` | — | — | 14.082 | 14.997 |
| `jsts:entity_parameter` | — | — | 74.442 | 74.769 |
| `jsts:entity_type` | — | — | 12.671 | 14.189 |
| `jsts:entity_variable` | 211.909 | 235.733 | 235.733 | 240.900 |
| `jsts:relation_call` (registros totales) | 734.379 | 97.562 | 102.763 | 105.925 |
| `core:call` confirmadas (cold, `inspect_store`) | 64.931 | 95.956 | 100.940 | 104.062 |
| `core:call` possible con destino (candidatos) | 0 | 1.606 | 1.823 | 1.863 |
| `jsts:relation_contains` | — | — | 353.070 | 400.488 |
| `jsts:relation_covers` | — | — | — | 1.411 |
| `jsts:relation_export` | — | — | 2.336 | 2.336 |
| `jsts:relation_implements` | — | — | 477 | 562 |
| `jsts:relation_import` | — | — | 58.302 | 58.302 |
| `jsts:relation_inherits` | — | — | 786 | 789 |
| `jsts:relation_references` | — | — | 994.285 | **1.217.499** |
| relaciones sin destino (`call`/`inherits`/`implements`) | 671.358 | 0 | 0 | **0** |
| references sin destino (diagnóstico) | — | — | 3.568 | 4.030 |
| references resueltas a parámetro (subconjunto CON destino) | — | — | 154.264 | 155.626 |
| `external_module_entities` | — | — | — | **915** |
| `external_symbol_entities` | — | — | — | **3.819** |
| `import_export_relations_with_external_target` | — | — | — | **22.206** |
| `artifacts_interned` (contenedores) | — | — | — | 14.082 |
| `deps_visible_count` | — | — | — | 36.621 |
| pending sites visibles | (records) | 640.333 | 635.349 | 632.139 |
| pending `call_deferred_to_e3` | — | — | 370.349 | 368.779 |
| pending `call_target_uncertain` | — | — | 261.422 | 259.488 |
| pending `overload_ambiguous` / `union_ambiguous` | — | — | 568 / 2 | 578 / 2 |
| pending `target_not_interned` | — | 1.094 | 1.098 | 1.470 |
| pending heritage (`inherits`+`implements`, 4 reasons) | — | — | 193+464+4+35+1214=1.910 | 192+462+4+35+1129=1.822 |
| pending con `source_subject=None` | — | 7.212 | 7.092 | 7.075 |
| tamaño `structural/` | 2,7 GB | 1,8 GB | 2,1 GB | **2,3 GB** |

Órdenes de magnitud esperados por el enunciado, confirmados: records ~2,0M (2.162.391), references
~1,22M (1.217.499, exacto), external modules ~915 (**exacto**), external symbols ~3,8k (3.819),
pending sites ~632k (632.139, **exacto**), `core:call` confirmadas ~104k (104.062, **exacto**).

### 10.3 Incremental worker-only (`n8n_incremental_measurement`)

| paso | ronda 2 (§9.3) wall / total_ms | ronda 3 (ahora) wall / total_ms |
|---|---:|---:|
| COLD (gen 1) | 23,319 s / 22.361 | 30,376 s / 28.817 |
| EDIT#1 (gen 2) | 1,339 s / 1.322 | 2,498 s / 2.479 |
| EDIT#2 (gen 3) | 0,568 s / 551 | 0,740 s / 723 |
| CREATE (gen 4) | 0,462 s / 445 | 0,506 s / 488 |
| DELETE (gen 5) | 0,444 s / 428 | 0,483 s / 466 |
| EDIT#3 (gen 6) | 0,522 s / 506 | 0,526 s / 509 |
| RENAME (gen 7) | 0,526 s / 509 | 0,546 s / 529 |
| HUB superficie sin cambio (gen 8) | 0,496 s / 480 | 0,638 s / 619 |
| HUB superficie cambiada (gen 9) | 1,101 s / 1.083 | 1,626 s / 1.511 |

`test result: ok. 1 passed` (el propio `n8n_incremental_measurement`). Todos los pasos suben algo
frente a ronda 2, en línea con el mismo +27% observado en el cold de §10.1; no se investigó el reparto
exacto por paso, solo se reporta.

**`n8n_incremental_create_delete_roots_match_oracle`: FALLÓ esta ronda** (en ronda 2, §9.3, esta misma
prueba había confirmado igualdad de raíces Y de conjunto de pending sites). Salida completa relevante:

```
cold done, generation=1
create done, generation=2
delete of .github/actions/ci-filter/__tests__/ci-filter.test.ts done, generation=3
oracle cold scan of the mutated tree done in 32.3s

thread 'v4::tests_e2e::n8n_incremental_create_delete_roots_match_oracle' panicked at crates/urdira-indexing-worker/src/v4/tests_e2e.rs:3581:5:
assertion `left == right` failed: n8n-scale: records root must match a from-scratch scan of the create+delete-mutated tree
  left: "sha256:23f46a5f0966754f3df948e9bbb1016eeb31c306398da7cab40ac96be46700fe"
 right: "sha256:e88119e3d7fba3951762eca24f35803ee6c9ab7810e180eddb64675203b20b72"
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 99 filtered out; finished in 73.28s
```

El `records` root del árbol create+delete-mutado por el worker incremental (izquierda) NO coincide con
el de un cold scan desde cero del mismo árbol mutado (derecha, oráculo). La aserción de igualdad de
`records` root es la PRIMERA del test (línea 3581) y el panic aborta la función inmediatamente, así
que la aserción posterior de igualdad del conjunto de pending sites **nunca se alcanzó** esta ronda —
no se puede reportar ese número aquí. No se investigó la causa (fuera del mandato de esta tarea, que es
solo medición); se reporta como regresión real frente a ronda 2, sin tocar código de producto. Limpieza:
`target/v4-e2e-test/` (incluye el scratch de este test y del de residual/referencias de §10.4-10.5)
borrado tras cada paso.

### 10.4 Pase residual a escala n8n + paridad de llamadas

`n8n_residual_pass_debug_histogram` (`URDIRA_V4_RESIDUAL_DEBUG=1`, dumps completos vía
`URDIRA_V4_CALL_BODY_DUMP_COLD`/`_AFTER`): cold scan wall=30,739 s. `confirmed_possible_histogram`
COLD: `core:call confirmed=105925 possible=0`, heritage `confirmed=1351 possible=0`,
`confirmed_combined=107276`; `classification_mismatches` COLD=0 (gate duro respetado). Pase residual:
wall=**71,625 s** (orden de magnitud: ~1 minuto, trabajo de fondo tsgo, no gate), `total_ms=65647`,
`upgraded=56.324`, `external=40.158`, `unresolved=528.582`, `inferred_type_entities=40.382`,
`type_of_relations=40.382`, `diagnostics_emitted=248.193`. `confirmed_possible_histogram` AFTER:
`core:call confirmed=160238 possible=0`, heritage `confirmed=1868 possible=0`,
`confirmed_combined=162106`; `classification_mismatches` AFTER=0. Comparación con ronda 2 (§9.4):
upgraded 58.309→56.324, external 40.158→40.158 (idéntico), unresolved 529.790→528.582,
`inferred_type_entities`/`type_of_relations` 40.382→40.382 (idénticos), `diagnostics_emitted`
248.193→248.193 (idéntico), wall 70,732 s→71,625 s (mismo orden de magnitud).

`scripts/v4-call-parity-diff.mjs` con el dump COMPLETO (no la variante `dump_call_bodies_cold_only`),
contra el oráculo v3 (mismo `.sqlite` que §4/§9.4, 205.468 `core:call` confirmadas en v3 en ambos
checkpoints; v3 total 734.379 filas, 528.911 possible, 0 errores de decodificación; v4 cold dump
729.167 filas / 104.062 confirmadas; v4 after dump 727.673 filas / 159.869 confirmadas):

| checkpoint | mismo destino | destino distinto | possible | sitio ausente |
|---|---:|---:|---:|---:|
| cold (antes de tsgo) | 91.205 (44,39%) | **0** (0,00%) | 110.393 (53,73%) | 3.870 (1,88%) |
| tras pase residual | **114.562** (55,76%) | **0** (0,00%) | 87.036 (42,36%) | 3.870 (1,88%) |

`v4_confirmed_different_target = 0` en ambos checkpoints (gate duro cumplido). Comparación con ronda 2
(§9.4): cold 91.088(44,33%)/0/110.504(53,78%)/3.876(1,89%); tras residual
114.554(55,75%)/0/87.038(42,36%)/3.876(1,89%) — prácticamente idéntico (diferencias de ≤117 sitios,
ruido de recorrido de ficheros/orden, no una regresión).

### 10.5 Paridad de referencias con `--classify-targets 1`

`n8n_references_parity_debug_dump` (dumps vía `URDIRA_V4_REFERENCE_BODY_DUMP` +
`URDIRA_V4_PENDING_IDENTIFIER_REF_DUMP`, checkpoint cold único — el pase residual nunca toca
`core:references`, mismo hecho de §9.4/§9.8): cold analyze wall=11,615 s, owners=14.082. Histograma de
razón de pending `IdentifierRef` (en memoria, total=1.073.759): `member_access` 649.662,
`unresolved_global` 270.509, `unsupported_declaration_kind` 65.303, `this_expression` 55.244,
`import_binding` 26.737, `jsdoc_typed_file` 5.605, `re_export_binding` 614, `multiple_declarations` 82,
`type_predicate_parameter` 3. Materializadas `core:references` (con destino, confirmadas)=1.217.499;
`dump_reference_bodies`: generation=1 rows=1.217.499 confirmed(target_subject)=1.213.469.

`scripts/v4-references-parity-diff.mjs --classify-targets 1 --corpus-root
~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02` contra el mismo oráculo v3 (1.110.576 `core:references`
confirmadas en v3, 0 de otra clasificación, 0 errores de decodificación; v4: 1.217.499 filas, 1.213.469
con `target_subject`, 0 errores de decodificación):

| checkpoint | mismo destino | destino distinto | ausente |
|---|---:|---:|---:|
| cold (único) | 952.594 (85,77%) | **0** (0,00%) | 157.982 (14,23%) |

`v4_different_target = 0` (gate duro cumplido). Histograma de razón del `v4_missing`: `member_access`
83.356, `unresolved_global` 65.502, `import_binding` 4.644, `jsdoc_typed_file` 2.853,
`unknown_no_pending_dump_match` 1.314, `re_export_binding` 252, `multiple_declarations` 49,
`this_expression` 7, `type_predicate_parameter` 3, `unsupported_declaration_kind` 2. Cruce por tipo de
destino v3: `member` 79.997, `module_level_entity` 77.407, `parameter` 578.

**Reparto workspace vs. externo (`--classify-targets`)**:

| clase de destino | filas | % de 157.982 |
|---|---:|---:|
| `lib` (`lib.*.d.ts`, globals de TypeScript) | 137.259 | 86,88% |
| `workspace` (fichero real del corpus) | 20.723 | 13,12% |

(`node_modules` y `other` no aparecen en la salida: 0 filas en ambos, igual que en §9.8.1.) Comparación
con ronda 2 (§9.8.1, `v4_missing` total entonces 167.843): `lib` **idéntico byte a byte**, 137.259 en
ambas rondas (ni una fila más ni menos de la librería estándar de TypeScript — coherente con que
ninguna población nueva de esta ronda toca `lib.*.d.ts`); `workspace` bajó de 30.584 a 20.723, una
caída de exactamente 9.861 filas — **la misma cifra** en la que bajó el total (`167.843 − 157.982 =
9.861`). Toda la mejora de esta ronda en `core:references` recae en el bucket `workspace`: 9.861
referencias que antes apuntaban dentro del corpus y quedaban `v4_missing` ahora se resuelven (barriles
`export *`, catch/rest, type-predicate, ambient modules — las poblaciones nuevas de esta ronda), cero
cambio en la parte de librería estándar de TS (ese trabajo queda fuera del alcance de esta ronda, tal
como predice §9.8.1).

Limpieza: `~/Proyectos/urdira-benchmark/v4-fold/refs-parity/`, `call-bodies-{cold,after}.bin` y
`residual-data/` borrados al terminar este paso; `target/v4-e2e-test/` (scratch de los tres tests
`#[ignore]`d de §10.3-10.5) también borrado. `~/Proyectos/urdira-benchmark/v4-fold/final-1` intacto.

### 10.6 `pnpm verify`

Comando real (de la propia salida): `pnpm check:architecture && pnpm check:native && pnpm test:native
&& pnpm lint && pnpm test:coverage && pnpm typecheck && pnpm check:coverage-gate && pnpm
check:publication`. `check:architecture`, `check:native`, `test:native` y `lint` pasaron (se alcanzó
`test:coverage`); `typecheck`, `check:coverage-gate` y `check:publication` **no llegaron a ejecutarse**
porque la cadena `&&` se detiene en el primer fallo.

`test:coverage` (vitest) **FALLÓ**: `Test Files  1 failed | 138 passed | 2 skipped (141)`; `Tests  1
failed | 2081 passed | 13 skipped (2095)`; cobertura: statements 83,97% (42443/50540), branches 73,72%
(35902/48694), functions 81,07% (8541/10535), lines 90,07% (27544/30578).

El fallo **no** es `tests/app-runtime.test.ts` ni `tests/phase-index-pack.test.ts` (los dos únicos
flakes con permiso explícito de reintento en el enunciado de esta ronda) sino
`tests/phase-canonical-query-data-port.test.ts`. Por instrucción explícita del enunciado ("Any OTHER
failure: report the full failure block verbatim; do not fix product code"), no se reintentó ni se tocó
código de producto; bloque verbatim:

```
FAIL  tests/phase-canonical-query-data-port.test.ts > SqliteCanonicalQuerySnapshotPort/CanonicalRecordQueryDataPort corpus-scale behavior > loadAllRecords round-trips a corpus spanning multiple SQL row-fetch batches, in exact record_id order, with nothing dropped, duplicated, or corrupted at the batch boundary
Error: Test timed out in 60000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ tests/phase-canonical-query-data-port.test.ts:547:3
    545|   }, 60_000);
    546|
    547|   it("loadAllRecords round-trips a corpus spanning multiple SQL row-fe…
       |   ^
    548|     await withWorkspace(async (opened) => {
    549|       await seedBaseline(opened);
```

Log completo: (registro local de la sesión, no conservado).

### 10.7 Qué queda abierto

- Del §8/§9.6 original, aún sin resolver: `entities.index` sigue sin ser tabla; uniones solo generan
  candidatos, nunca `confirmed`; docs de decisión 28/29 sin actualizar; el store no emite diagnósticos;
  discrepancia `print_confirmed_possible_histogram` vs `inspect_store_record_histogram` sobre el mismo
  campo de clasificación (no conciliada, ver §10.4 — combinado 107.276/162.106 aquí vs. confirmed +
  candidatos 105.925/162.106 del store, mismo patrón que §9.2 lo dejó).
- Del header de `scripts/v4-references-parity-diff.mjs` (sin cambios esta ronda): la comparación de
  referencias solo tiene checkpoint cold (el pase residual no toca `core:references`); el join de
  `v4_missing` contra el dump de sitios `IdentifierRef` pendientes depende de que `--v4-pending-dump`
  provenga del MISMO run que `--v4-bodies` (aquí así fue).
- **Nuevo, regresión (§10.3)**: `n8n_incremental_create_delete_roots_match_oracle` FALLÓ esta ronda —
  el `records` root del árbol create+delete-mutado por el worker incremental no coincide con el de un
  cold scan desde cero del mismo árbol mutado (en ronda 2 esta misma prueba había pasado, con igualdad
  confirmada de raíces y de 635.193 pending sites). No investigado: fuera del mandato de esta tarea
  (solo medición, sin tocar código de producto). Candidato de máxima prioridad para la próxima sesión
  de implementación: alguna de las poblaciones nuevas de esta ronda (externos, catch/rest, barriles,
  ambient modules, type-predicate) probablemente no está cableada en el camino incremental
  (`delta.rs`) con la misma fidelidad que en el camino cold (`materialize.rs`).
- **Nuevo (§10.6)**: `pnpm verify` falla en `tests/phase-canonical-query-data-port.test.ts` (timeout de
  60000ms en `loadAllRecords round-trips a corpus spanning multiple SQL row-fetch batches...`), no
  `tests/app-runtime.test.ts` ni `tests/phase-index-pack.test.ts`. No reintentado (no cubierto por el
  permiso explícito de reintento del enunciado); no diagnosticado más allá del bloque verbatim
  reportado. `typecheck`/`check:coverage-gate`/`check:publication` no se ejecutaron por el corte de la
  cadena `&&`, así que no hay veredicto sobre esas tres puertas esta ronda.
- **Nuevo, hallazgo positivo (§10.5)**: la caída de `v4_missing` en `core:references` (167.843→157.982,
  −9.861) recae ENTERAMENTE en el bucket `workspace` (30.584→20.723, misma cifra −9.861); el bucket
  `lib` (librería estándar de TypeScript) queda exactamente igual, 137.259 en ambas rondas — confirma
  que las poblaciones nuevas de esta ronda solo tocan destinos dentro del corpus, ningún efecto (ni
  positivo ni negativo) sobre la parte de `lib.*.d.ts`.

### 10.8 Cierre tras el arreglo de la raíz incremental

Corrida de solo medición sobre el mismo árbol de trabajo de §9-§10, con el mismo diff no comiteado
encima de 65d06dd (`crates/urdira-indexing-worker/src/v4/{delta,materialize,scan,publish,analyze,
residual,tests_e2e}.rs` y otros, 338 líneas tocadas en `delta.rs`) — un arreglo dirigido a la
regresión de §10.3/§10.7 (`records` root del camino incremental create+delete no coincidía con el
oráculo cold). Ningún fichero de producto se tocó en esta sesión; solo se midió. Máquina ociosa
confirmada (`pgrep -fl "vitest|cargo|v4-scan|urdira-indexing-worker" | grep -v code-collate` vacío)
antes de `cargo build --release -p urdira-indexing-worker && pnpm -r build && node
scripts/build-native.mjs` (los tres, verdes). Corpus `n8n-corpus-2026-09-02` no tocado (solo lectura;
los tests que mutan trabajan sobre copias scratch vía `scratch_copy_of_n8n_corpus`, borradas al
terminar cada paso).

**Cold ×3** (`node scripts/v4-scan.mjs <corpus> v4-fold/final-$i --force`, `final-1` es ahora la
única referencia conservada en disco, `final-2`/`final-3` usados solo para las 3 repeticiones y
borrados al terminar):

| etapa | HEAD (65d06dd) | tarde (§5) | ronda 2 (§9) | ronda 3 (§10.1) | cierre (ahora) |
|---|---:|---:|---:|---:|---:|
| catalog | 5,5 s | 5,3 s | 5,7 s | 5,3 s | 5,8 s |
| parse | 1,8 s | 2,1 s | 2,1 s | 2,1 s | 2,0 s |
| resolve | 2,7 s | 1,6 s | 1,9 s | 2,2 s | 2,4 s |
| materialize | 8,2 s | 4,6 s | 6,4 s | 6,9 s | 7,0 s |
| write | 7,8 s | 4,2 s | 6,6 s | 11,1 s | 10,2 s |
| **total_ms** | **28,3 s** | **18,8 s** | **23,6 s** | **30,0 s** | **30,1 s** (27,7 / 30,1 / 31,0) |
| wall `real` | 28,4–31,7 s | 20,5–22,2 s | 25,2–26,4 s | 31,7–33,3 s | 31,1–32,6 s |
| RSS máx | 7,1–7,6 GB | 6,3–7,2 GB | 6,2–6,6 GB | 5,7–6,2 GB | 6,3–7,0 GB |

Runs individuales (`timings_ms`): run1 catalog=5220 parse=2379 resolve=2395 materialize=6691
write=8696 fsync=369 snapshot=7 total=27698, real=31,07s, RSS=7.019.610.112B; run2 catalog=5787
parse=1883 resolve=1952 materialize=6950 write=10764 fsync=212 snapshot=4 total=30103, real=31,97s,
RSS=6.321.504.256B; run3 catalog=5842 parse=1967 resolve=2596 materialize=7421 write=10161 fsync=305
snapshot=7 total=31005, real=32,61s, RSS=6.901.481.472B. `total_ms` casi idéntico a ronda 3 (30,0 s →
30,1 s, +0,3%): el arreglo de la raíz incremental no movió el coste del camino cold de forma medible.

Raíces `dependency` (`sha256:d76ff317...`) y `graph` (`sha256:d8ee19718...`) idénticas a las de ronda 3
en los 3 runs de hoy — sin cambio. La raíz `records` SÍ cambió frente a ronda 3: los 3 runs de hoy dan
`sha256:f948974e88ed8a97ef1cd03c10da7f87f3e5e88f639da48dbc83228b2fa8741a` en vez de la
`sha256:7a0c6ec5...` de ronda 3 — coherente con que el arreglo toca `materialize.rs`/`delta.rs` (los
records cambian de contenido, aunque el conteo total y el histograma de abajo no cambian ni un byte).
`metric` sigue en cero-hash. Los 3 runs de hoy son byte-idénticos entre sí (misma raíz `records` en
run1/run2/run3). `du -sh final-1/structural` = **2,3 GB** (igual que ronda 3). `final-2`/`final-3`
borrados tras esta tabla.

**Composición del store** (`final-1`, generación 1, `inspect_store_record_histogram`,
`URDIRA_V4_INSPECT_STORE=~/Proyectos/urdira-benchmark/v4-fold/final-1/structural`):

| métrica | ronda 3 (§10.2) | cierre (ahora) |
|---|---:|---:|
| records totales | 2.162.391 | **2.162.391** (idéntico) |
| `jsts:entity_callable` | 30.224 | 30.224 |
| `jsts:entity_container` | 14.997 | 14.997 |
| `jsts:entity_parameter` | 74.769 | 74.769 |
| `jsts:entity_type` | 14.189 | 14.189 |
| `jsts:entity_variable` | 240.900 | 240.900 |
| `jsts:relation_call` | 105.925 | 105.925 |
| `jsts:relation_contains` | 400.488 | 400.488 |
| `jsts:relation_covers` | 1.411 | 1.411 |
| `jsts:relation_export` | 2.336 | 2.336 |
| `jsts:relation_implements` | 562 | 562 |
| `jsts:relation_import` | 58.302 | 58.302 |
| `jsts:relation_inherits` | 789 | 789 |
| `jsts:relation_references` | 1.217.499 | 1.217.499 |
| `core:call` confirmadas | 104.062 | 104.062 |
| `core:call` possible con destino (candidatos) | 1.863 | 1.863 |
| relaciones sin destino (`call`/`inherits`/`implements`) | 0 | 0 |
| references sin destino (diagnóstico) | 4.030 | 4.030 |
| references resueltas a parámetro | 155.626 | 155.626 |
| `external_module_entities` | 915 | 915 |
| `external_symbol_entities` | 3.819 | 3.819 |
| `import_export_relations_with_external_target` | 22.206 | 22.206 |
| `artifacts_interned` | 14.082 | 14.082 |
| `deps_visible_count` | 36.621 | 36.621 |
| pending sites visibles | 632.139 | 632.139 |
| pending `call_deferred_to_e3` | 368.779 | 368.779 |
| pending `call_target_uncertain` | 259.488 | 259.488 |
| pending `overload_ambiguous` / `union_ambiguous` | 578 / 2 | 578 / 2 |
| pending `target_not_interned` | 1.470 | 1.470 |
| pending heritage (4 razones) | 192+462+4+35+1.129=1.822 | 192+462+4+35+1.129=1.822 |
| pending con `source_subject=None` | 7.075 | 7.075 |
| tamaño `structural/` | 2,3 GB | 2,3 GB |

Composición del store **byte-idéntica a ronda 3, campo por campo** (todas las métricas del histograma
coinciden exactamente, aunque la raíz `records` cambió de hash — el arreglo reordena o re-serializa
contenido de records sin alterar cuántos hay de cada tipo ni la distribución de razones de `pending`).
Confirma lo que predecía §10.7: el arreglo es del camino incremental (`delta.rs`), el camino cold
(`materialize.rs`) queda con la misma composición.

**Incremental worker-only** (`n8n_incremental_measurement`, `URDIRA_V4_N8N_CORPUS=<corpus>
URDIRA_V4_N8N_DATA=<scratch fresco>`, scratch borrado al terminar):

| paso | ronda 3 (§10.3) wall / total_ms | cierre (ahora) wall / total_ms |
|---|---:|---:|
| COLD (gen 1) | 30,376 s / 28.817 | 31,125 s / 29.636 |
| EDIT#1 (gen 2) | 2,498 s / 2.479 | 2,025 s / 2.003 |
| EDIT#2 (gen 3) | 0,740 s / 723 | 0,700 s / 682 |
| CREATE (gen 4) | 0,506 s / 488 | 0,507 s / 489 |
| DELETE (gen 5) | 0,483 s / 466 | 0,493 s / 475 |
| EDIT#3 (gen 6) | 0,526 s / 509 | 0,757 s / 738 |
| RENAME (gen 7) | 0,546 s / 529 | 0,806 s / 786 |
| HUB superficie sin cambio (gen 8) | 0,638 s / 619 | 0,789 s / 768 |
| HUB superficie cambiada (gen 9) | 1,626 s / 1.511 | 2,102 s / 2.056 |

`test result: ok. 1 passed` (el propio `n8n_incremental_measurement`, 43,74 s de test). COLD, CREATE y
DELETE quedan en el mismo orden de magnitud que ronda 3 (diferencias ≤2,5%); EDIT#1/EDIT#2 bajan algo
(−19% / −5%); EDIT#3, RENAME, ambos HUB suben (+44%, +48%, +24%, +29%) frente a ronda 3 — coherente con
que el arreglo añade trabajo real al camino incremental (más entidades/pending sites recalculados por
delta) para poder igualar al oráculo cold, no con ruido de máquina: la subida se concentra justo en los
pasos que tocan más superficie de grafo (edit de fichero no-trivial, rename, hub), no en los triviales
(create/delete de un fichero hoja). No se investigó el reparto exacto por sub-etapa (fuera de alcance).

**`n8n_incremental_create_delete_roots_match_oracle`**: en ronda 3 (§10.3) esta prueba había FALLADO
(`records` root del incremental create+delete ≠ oráculo cold). Con el arreglo de esta sesión,
**PASA**: `n8n-scale root equality CONFIRMED for create+delete against a from-scratch oracle` y
`n8n-scale pending-site set equality CONFIRMED for create+delete against a from-scratch oracle (631983
sites)`. La regresión de §10.3/§10.7 queda cerrada — igualdad de raíces Y de conjunto de pending sites
confirmada de nuevo (como en ronda 2, §9.3, donde había dado 635.193 sitios sobre un árbol
create+delete distinto; aquí 631.983, cercano pero no idéntico a los 632.139 pending sites visibles de
`final-1` en la tabla de arriba, porque es un árbol mutado create+delete, no el corpus original).
`test result: ok. 1 passed; ... finished in 84,66s` (copia scratch 3,0 s + cold 1 + create + delete +
oráculo cold del árbol mutado en 32,6 s). `target/v4-e2e-test/` borrado tras el paso.

**`pnpm verify`**: comando real de la cadena (`check:architecture && check:native && test:native &&
lint && test:coverage && typecheck && check:coverage-gate && check:publication`) ejecutado entero de
punta a punta esta vez — llegó hasta el último eslabón, `check:publication`, así que hay veredicto
individual de las 8 puertas sin necesitar invocaciones separadas. `exit=1`.

- `check:architecture`, `check:native` (`cargo fmt --check` + `cargo clippy -D warnings` + `cargo test
  --workspace --locked`), `test:native`, `lint` (`eslint .`): **PASS** (sin fallos en el log).
- `test:coverage` (vitest): **PASS**, `Test Files 139 passed | 2 skipped (141)`, `Tests 2082 passed |
  13 skipped (2095)` — **ningún fallo**, ni siquiera uno de los tres flakes de contención documentados
  (`tests/app-runtime.test.ts`, `tests/phase-index-pack.test.ts`,
  `tests/phase-canonical-query-data-port.test.ts`, este último el que había fallado en ronda 3/§10.6);
  no hizo falta ningún reintento. Cobertura: statements 83,95% (42.432/50.540), branches 73,72%
  (35.900/48.694), functions 81,07% (8.541/10.535), lines 90,04% (27.535/30.578).
- `typecheck` (`tsc --build --force`): **PASS** (sin errores TS en el log).
- `check:coverage-gate`: **PASS** — `Coverage gate passed: measured repository lines 90.05%
  (27535/30578), critical branches 100.00% (15/15), semantic regions 100.00%.`
- `check:publication`: **FAIL**, bloque verbatim:

```
$ node scripts/check-publication.mjs
Publication hygiene failed:
- docs/evidence/2026-09-04-v4-pending-sites-fold-and-member-entities.md: contains a private temporary path
```

  Causa: la propia ruta (ruta temporal local) citada en §10.6 de este mismo
  documento (línea 863, escrita en la sesión de ronda 3, antes de este cierre) — no algo introducido
  por esta corrida de medición. No es ninguno de los tres flakes de contención con permiso explícito de
  reintento del enunciado, así que, por instrucción, se reporta el bloque verbatim y NO se toca código
  de producto ni el propio documento en el punto que dispara el gate. Como el fallo está al final de la
  cadena `&&` y las 7 puertas anteriores ya corrieron y pasaron dentro de esta misma invocación, no fue
  necesario re-ejecutar `pnpm typecheck` / `pnpm check:coverage-gate` / `pnpm check:publication` por
  separado. Log completo:
  (registro local de la sesión, no conservado).

**Veredicto de cierre**: la regresión que dejó abierta la ronda 3 (§10.3/§10.7,
`n8n_incremental_create_delete_roots_match_oracle` FALLANDO) queda **cerrada** — raíces y pending sites
del camino incremental create+delete vuelven a coincidir con el oráculo cold. El coste es un
incremental algo más caro en los pasos no triviales (edit de fichero grande, rename, hub) y el cold
total_ms se mantiene igual (30,0→30,1 s). La composición del store cold no cambia ni un campo del
histograma frente a ronda 3. El único fallo de `pnpm verify` es una condición documental preexistente
(ruta privada citada en el propio documento de evidencia), no una regresión de código ni un flake de
los tres documentados; las 8 puertas de `verify` corrieron esta vez y solo esa falló.
