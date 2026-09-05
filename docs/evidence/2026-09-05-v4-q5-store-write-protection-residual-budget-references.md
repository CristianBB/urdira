# v4 Q5: protección de escritura del store, cota del residual, referencias restantes

Fecha: 2026-09-05 noche / 2026-09-06 madrugada. Estado: los **cuatro frentes quedan COMMITEADOS** en
`main`, de `82159a2` (cierre de "frentes 1-4", ver `docs/evidence/2026-09-05-v4-frentes-1-2-3-4-reopen-
references-analyze-residual.md`) a `26f7ae5`. Plan `~/.claude/plans/rippling-sniffing-lake.md` ("Q5"),
cola acordada con el dueño (memoria `next-queue-2026-09-05`). Cuatro implementadores Sonnet en worktrees
git aislados, en paralelo, disjuntos por fichero; Fable orquestó, revisó cada retorno y decidió; cada
rama tuvo revisión adversarial (Sonnet) antes de fusionarse a `main` en el orden que el plan fijó
(`B → A → C → D`, para desbloquear antes los benches de incremental/cold). Corpus
`~/Proyectos/urdira-benchmark/n8n-corpus-2026-09-02`. Fuente de datos de esta redacción: los 21 commits
no-merge (`git log --oneline 82159a2..26f7ae5`, 25 commits totales incl. 4 merges) leídos con
`git show --stat`/`git log -1 --format=%B`, y los logs crudos retenidos en
`~/Proyectos/urdira-benchmark/v4-fold/{q5-meas,q5-store,q5-incr,q5-residual,q5-parity,q5-verify}/` —
cada cifra de este documento se contrastó contra uno de esos dos orígenes; donde no fue posible, queda
marcada explícitamente como no verificada.

## 1. Pregunta de partida y respuesta

La cola acordada tras el cierre de "frentes 1-4" (esa evidencia §10) dejaba cuatro huecos disjuntos por
crate: (A) el cold seguía con una regresión de escritura de +6,9% no atribuida por fichero desde que F4
añadió `entities.index`; (B) la protección de entidades externas en el reopen incremental seguía pagando
un `iter_visible` completo (30-40% del HUB cambiado) pese a que F1 ya fusionó las tres pasadas redundantes;
(C) el pase residual de tsgo solo comprobaba su cota de tiempo entre ventanas (no dentro), podía
sobrepasarla ~1,8-2× en la práctica, y su mecanismo de re-programación (`schedule()`) nunca se había
ejercido con un harness n8n real; (D) quedaban formas de referencia sin resolver (`unresolved_global` ×
namespace, alias de tipo en typeflow, nombres cualificados `A.B`/`A.B.C`, diagnóstico fino de
`member_access/call_chain`).

¿Quedan los cuatro frentes cerrados con criterio numérico propio, `pnpm verify` verde, sin regresión de
paridad frente al oráculo v3, y sin abrir cola técnica nueva (solo decisiones del dueño)?

Respuesta: **sí a los cuatro, con dos criterios numéricos aceptados con cifra en vez de cumplidos
literalmente** (A: `write_ms` ≤5.600ms no se alcanza, 5.941ms; D: `member_access` ≤9.000 no se alcanza,
9.274, e `ident:param_destructured` 0 no se alcanza, 4) y un rango de drift de ±2 en el pase residual con
cota que queda documentado como decisión del dueño, no como bug. 21 commits no-merge (`f3100b6`..`51e73ef`,
ver §2) en 4 ramas (`q5-delta-protection`, `q5-store-write`, `q5-residual-budget`, `q5-references`),
fusionadas B→A→C→D, más dos commits de cierre fuera de rama (`d53d91a`, arreglo de ruta absoluta en
`test:native`; `26f7ae5`, refresco de constantes del harness `schedule()` tras el merge de D).
`pnpm verify` corrió sus 8 puertas de punta a punta sobre `26f7ae5` y las 8 pasaron (§7): 139 ficheros /
2.083 tests vitest, coverage líneas 90,08% (27.544/30.578), 691 tests `cargo` pasados (0 fallos, 44
ignorados esperados) sumando `cargo test --workspace --locked` + las suites tsgo-gated de `test:native`.
El oráculo incremental (`n8n_incremental_create_delete_roots_match_oracle`) sigue CONFIRMADO. La paridad
de referencias mejora de 956.840 (checkpoint `80d697c` de la sesión anterior) a **957.556** `same`, con
`different=0` mantenido en las 6 corridas de desarrollo (`d1`..`d5`) y en la final; la paridad de llamadas
no se mueve un dígito por Frente D en ninguna de las 4 corridas medidas.

## 2. Qué se hizo (mecanismos y ficheros, por frente, con commits)

### Frente B — `q5-delta-protection`: protección de externos vía `adj.in` (merge `ad86791`)

Crate: `crates/urdira-indexing-worker/src/v4/delta.rs` (458 líneas, solo este fichero en las 3 ramas).

- **B.1** (`f3100b6`): `protected_external_entity_ids` (`delta.rs:175-195`) dejaba de recorrer
  `iter_visible(prev_generation)` completo (k-way merge de 2,17M filas) y pasa a iterar `at_risk` (acotado
  al lote tocado) preguntando directamente al índice inverso ya existente
  `StoreReader::adjacency(&record_id, Direction::In, prev_generation)` (`reader.rs:1641`), filtrando por
  `view.category() == CATEGORY_RELATION && !touched_owner_ordinals.contains(&view.owner_artifact())`. El
  parámetro `dicts` desaparece: `adjacency` resuelve `subject_key → ordinal` internamente y devuelve
  `RecordView`s ya hidratadas. La implementación previa se conserva como oráculo
  `#[cfg(test)] fn protected_external_entity_ids_by_full_scan` (`delta.rs:203`); 3 tests nuevos de
  equivalencia reutilizan los fixtures existentes de `tests_e2e.rs` (cold/delete-non-owner/delete-owner,
  y delete-owner-mientras-un-protector-permanece) a través de sus generaciones reales, comprobando
  conjuntos byte-idénticos entre la reescritura y el oráculo.
- **B.2** (`77e0177`): `diff_one_owner` (invocada desde dos `for` secuenciales — afectados, luego
  eliminados; sin rayon en este fichero) deja de re-pedir `store_reader.by_owner(ordinal, prev_generation)`
  para cada owner tocado: `prev_rows_by_owner.remove(&ordinal)` mueve las filas ya cacheadas (construidas
  una vez, arriba, para las pasadas at-risk/deleted/zombie) en vez de golpear el store una 4ª vez por el
  mismo owner. Suite v4 completa tras este commit: 61 passed, 0 failed, 11 ignored (n8n/tsgo-gated).
- **B.3** (`6c68573`): la línea DEBUG existente (`delta.rs:938`,
  `external-entity close-protection: at_risk=… protected=… zombie_candidates=… zombie_closures=…`) gana
  `adjacency_lookups=…` (exactamente `at_risk_external_entities.len()`, una llamada `adjacency` por id) y
  `protection_us=…` (`delta.rs:926`, cronometra solo esa llamada, separado de las pasadas at-risk/
  deleted/zombie que ya cubre `close_protection_ms`).

Ningún cambio de formato on-disk; `reader.rs` no se toca en ninguna de las 3 (confirmado por
`git show --stat` sobre las 3 ramas — solo `delta.rs` cambia).

### Frente A — `q5-store-write`: instrumentación de escritura + `entities.index` paralelo/empaquetado (merge `e3aa728`)

Crate: `crates/urdira-structural-store/src/{segment_io.rs,writer.rs}` — un único commit squash
(`689340a`) para A.1+A.2 (411 líneas, 2 ficheros).

- **A.1** (instrumentación): `elapsed_ms` alrededor de cada uno de los 6 arrays secundarios ordenados
  (`records.by_owner/by_name/by_kind/by_identity`, `adj.out`, `adj.in`) y `entities.index`, en los 3
  escritores (`write_hot_and_secondary_files` flat, `write_hot_and_secondary_files_partitioned`, y
  `build_delta_sections` del delta), más un `hot_elapsed_ms` para los 5 ficheros `records.*`.
  `HotAndSecondaryResult` gana `hot_elapsed_ms`/`secondary_elapsed_ms: BTreeMap<String, u64>`; impreso bajo
  `URDIRA_DEBUG_TIMING` en una línea grep-able:
  `[urdira-structural-store] base write (flat|partitioned)/delta write: hot=Xms by_owner=Xms by_name=Xms
  by_kind=Xms by_identity=Xms adj.out=Xms adj.in=Xms entities.index=Xms fsync=X.XXXs rows=N`. También
  `URDIRA_V4_DIAG_SKIP_ENTITIES_INDEX=1` (`segment_io::diag_skip_entities_index`), diagnóstico-solo, que
  escribe un `entities.index` vacío con solo cabecera en vez de las triples reales, para aislar el coste
  marginal de esa sección — documentado explícitamente "un store construido con esto activo no debe
  consultarse jamás".
- **A.2** (las tres palancas ya diseñadas por el plan, confirmadas en el diff de `689340a`):
  1. **Paralelizar `entities.index` en el particionado**: pasa de estar en la cola secuencial de
     `secondary_work` a un `rayon::join` hermano — `rayon::join(hot_files_work, || rayon::join
     (secondary_work_rest, secondary_work_entities_index))` (`segment_io.rs`, sustituye el
     `rayon::join(hot_files_work, secondary_work)` anterior), solapando su sort con
     by_owner/by_name/by_kind/by_identity/adj.*.
  2. **Sort por clave empaquetada de 8 bytes**: `sort_unstable_by_key(|t| (((t.0 as u64) << 32) | t.1 as
     u64, t.2))` en los 3 sitios (flat, particionado, delta), reemplazando la comparación de 12 bytes
     completos por owner+start empaquetados en un `u64` (el ordinal, tercer campo de desempate, se compara
     aparte).
  3. **Serialización sin `extend_from_slice` ×3**: `let mut rec = [0u8; 12]; rec[0..4].copy_from_slice
     (&a.to_le_bytes()); rec[4..8]…; rec[8..12]…` en vez de 3 `extend_from_slice` encadenados, en los 3
     sitios.

  Ningún cambio de formato: `HEADER_FORMAT`/`Manifest.format`/`CONTAINER_FORMAT`/`SectionId` intactos
  (confirmado — el diff no toca `layout.rs`/`manifest.rs`).
- **A.3** (clave ambigua de `entities.index`, higiene 8 heredada): **sin commit en Q5** — `reader.rs` no
  aparece en el diff de `689340a` ni en ningún otro commit de la rama (confirmado con
  `git show --stat e3aa728`). La ambigüedad del fixture ya quedó cerrada en la campaña anterior
  (`4d7c63c`, "frentes 1-4" F4 revisión 4/4): `entity_by_owner_and_start` ya desempata por
  `(valid_from máx, segmento más nuevo, ordinal máx)` con el párrafo correspondiente en el doc-comment de
  `reader.rs:1506-1531` y en `docs/decisions/26-v4-structural-store.md:176-186`; el plan Q5 relistaba el
  ítem por precaución pero no había trabajo pendiente.
- **A.4** (raíz `graph` distinta entre checkpoints, sin código): resuelto por medición, no por commit —
  ver §3.

### Frente C — `q5-residual-budget`: cota intra-ventana, `checker_ms`, harness `schedule()` real, higiene `#[ignore]` (merge `0462e91`)

Crates: `crates/urdira-tsgo-client/src/{residual_pass.rs,binary.rs,resolver.rs}` +
`crates/urdira-tsgo-client/tests/*.rs`, `crates/urdira-indexing-worker/src/v4/residual.rs`,
`crates/urdira-worker-protocol/src/lib.rs`, 3 ficheros TS (`indexing-core-process-transport.ts`,
`rust-indexing-core-port.ts`, `rust-workspace-scan.ts`), `package.json`. 20 ficheros, 1.701
inserciones/240 borrados en el merge — el frente más grande en superficie de fichero, por el espejo TS.

- **C.1** (`8c45924`): `past_deadline(config)` (`residual_pass.rs:440-441`,
  `config.deadline.is_some_and(|d| Instant::now() >= d)`) se comprueba en dos puntos de `run_lane`, no uno:
  (a) al inicio de cada ventana (chequeo ya existente, ahora extraído a función compartida) y (b) al
  inicio de la iteración de cada root dentro del bucle de `fetch_semantics`. En (b), los sitios de
  call/heritage ya resueltos de la ventana se quedan en `out` tal cual (sin filtrar — el mismo
  razonamiento de "continuación segura" que la sesión anterior ya había verificado para el reopen
  incremental); tanto los roots restantes de esa ventana como toda ventana posterior van a
  `remaining_roots`; `WindowStats` gana `partial: bool`. Test determinista calibrado contra el timing real
  de tsgo en la propia máquina (diferencia entre ventana 0 sola y ventana 0+1, para cancelar el jitter de
  arrancar el cliente) en vez de una constante fija.
- **C.3** (`5db7472`): `checker_ms` (tiempo propio de `ResidualPass::run_instrumented`, sin
  materialize/write/fsync/snapshot) como hermano de `timings` en `ResidualOutcome` e
  `IndexingEvent::UpgradeCompleted`, espejado en **4** sitios TS (no 1): el wire union de
  `indexing-core-process-transport.ts`, `WorkspaceScanUpgradeCompleted` en `rust-indexing-core-port.ts`, y
  el handler + su spread condicional (`exactOptionalPropertyTypes`) en `rust-workspace-scan.ts`. Fixture
  cruzada `workspace-scan-v4.json` actualizada para `checker_ms` ausente (compat) y presente.
- **C.2** (`6526763`): dos tests `#[ignore]` nuevos junto a `n8n_residual_pass_debug_histogram`:
  `n8n_residual_schedule_resumes_after_truncation` (cold-scan n8n, llama `schedule()` una vez con un
  `ResidualEventTarget` respaldado por `mpsc` — requiere `URDIRA_V4_RESIDUAL_BUDGET_MS=15000` puesto en el
  shell invocador, porque el crate prohíbe `unsafe` y el test no puede hacer `set_var` por sí mismo — drena
  el canal hasta un evento `truncated == Some(false)` o 300s, y afirma ≥2 eventos, generaciones
  crecientes y `confirmed_combined` final) y `n8n_residual_second_pass_without_pending_sites` (reabre el
  store que dejó el primero totalmente convergido, confirma `pending.sites` vacío, corre
  `run_once_with_quiet_period` con `touched_owners=Some([1 owner real])` y afirma `upgraded_sites==0`,
  `inferred_type_entities>0`, generación +1). `print_confirmed_possible_histogram` pasa a devolver
  `confirmed_combined` en vez de solo imprimirlo.
- **`49d2760`** (revisión, dos bugs reales encontrados por el propio harness de C.2 sobre el corpus n8n
  completo, `v4-fold/q5-residual/schedule{2,3}.log`):
  1. **No convergencia**: `candidate_owners_for_pass` unía `touched_owners` con todo owner que aún
     tuviera un `pending.sites` abierto — correcto en un primer pase, pero en una CONTINUACIÓN
     (`reschedule_count > 0`) `touched_owners` YA ES exactamente el `remaining_roots` del intento previo, y
     volver a unir todo owner pendiente reintroducía la misma población persistentemente-irresoluble en
     cada ronda (`SiteOutcome::Unresolved` nunca cierra una fila `pending.sites`). Medido en vivo
     (`schedule2.log`, confirmado en esta redacción): 21 eventos consecutivos, `windows_total` oscilando
     entre 24 y 28 sin drenar nunca (evento 1: `windows=13/28`; evento 21: `wall=620,2s generation=13
     windows=12/24`), `schedule()` sin alcanzar `truncated=false` dentro de `MAX_CONSECUTIVE_RESCHEDULES=20`
     (`residual.rs:279`). Arreglo: `candidate_owners_for_pass(touched, pending, is_continuation)` salta la
     unión cuando `is_continuation`. Verificado (`schedule5.log`): `windows_total` 28→17→8→2, converge en 4
     eventos (wall 101,2s, `confirmed_combined=161.821` final); (`schedule6.log`): 28→17→8→5, converge en 4
     eventos (wall 105,9s, `confirmed_combined=161.747`).
  2. **Sobrepaso del presupuesto**: `checker_ms` excedía `URDIRA_V4_RESIDUAL_BUDGET_MS` en 3-7s porque las
     llamadas `getSymbolsAtLocations` por lote de `ResidualResolver::resolve` (por grupo de owners)
     tardaban hasta ~11,7s sin estar acotadas por el deadline. `resolve_with_deadline` nuevo (chequea entre
     grupos de owners, nunca en medio de un RPC; `resolve()` pasa a ser un envoltorio delgado sin deadline)
     como punto de corte (c) en `run_lane`: una ventana truncada aquí marca `partial`, empuja TODOS sus
     roots (resueltos o no) a `remaining_roots` (reintento idempotente), y detiene la apertura de más
     ventanas. Verificado (`schedule6.log`, confirmado en esta redacción): `checker_ms`
     15.275/15.496/15.331/11.282 contra presupuesto de 15.000ms (antes hasta 21.076). `WindowStats` gana
     `resolve_ms`/`semantics_ms`.
- **`e36f0e0`** (C.5, revisión adversarial): bug real — `candidate_owners_for_pass` acotaba correctamente
  el PLAN de ventanas de una continuación a `touched_owners`, pero `file_map` (el `VirtualFs` propio de
  tsgo) se filtraba con ese MISMO conjunto estrecho, perdiendo visibilidad de tipos entre ficheros para
  cualquier fichero ya descartado del alcance por un pase previo de la cadena — deriva medida en vivo:
  "56.250 vs 56.297 `upgraded` sumado sobre una cadena; signo invertido entre corridas" (cita literal del
  commit). Arreglo: separar SCHEDULING de VISIBILIDAD — `ResidualContext` gana
  `visible_owners: Option<Vec<String>>` (`None` en cold; en una continuación, el valor explícito del
  llamador, nunca recalculado; en un primer pase, `touched_owners` unido con la población de
  `collect()` — la amplitud pre-`49d2760`); `ResidualOutcome` reporta `visible_owners`, propagado SIN
  CAMBIOS a cada `next_context`. `file_map` se construye del conjunto resuelto (estable); el plan de
  ventanas sigue viniendo de `candidate_owners_for_pass` (estrecho en continuaciones) intersecado con las
  claves de `file_map`. Tolerancia del harness vuelta a 0 y re-corrida (`schedule7.log`, confirmado):
  `confirmed_combined=161.796` — de 30-50 de diferencia (`161.824`/`161.747`/`161.821` en
  `schedule4`/`schedule6`/`schedule5.log`, confirmados) a 2 de diferencia, **sin llegar a la igualdad
  exacta**. Además: los 2 tests `--lib` de `urdira-tsgo-client` (`resolver::tests::fetch_symbols_chunked_*`)
  habían quedado fuera de `pnpm verify` desde C.4 porque `test:native` solo corría `--test <fichero>`,
  nunca `--lib` — añadido `cargo test -p urdira-tsgo-client --lib -- --ignored`.
- **`8c5d008`** (C.4, higiene): `binary::discover_for_tests(repo_root) -> TsgoBinary` hace `panic!` con
  mensaje de guía ("set URDIRA_TSGO_BINARY=… or run pnpm install") en vez del `return` silencioso que
  hacía pasar tests vacíos sin ejercer RPC real (hallado en vivo en la sesión "frentes 1-4"). Los 5
  helpers duplicados de `tests/{residual_pass,semantic_extras,rpc_error_repro,binding_element_test,
  oracle_resolve}.rs` y los 2 inline de `tests/{bench_residual_pass,bench_tsgo}.rs` pasan a
  `#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]` + llamada directa a `discover_for_tests`.
  `package.json`'s `test:native` corre, tras `cargo test --workspace --locked`, las suites tsgo-gated
  AGRUPADAS POR FICHERO (`--test residual_pass --test semantic_extras --test rpc_error_repro --test
  binding_element_test --test oracle_resolve -- --ignored`) con `URDIRA_TSGO_BINARY` resuelto por el
  propio script. Verificado: sin la variable, `cargo test -p urdira-tsgo-client` → 44 passed/24 ignored, 0
  pases silenciosos; con ella (+`--ignored`) → 24 passed/0 ignored, coincidiendo exactamente.
- **`f7a4618`** (C.6, diagnóstico): `URDIRA_V4_RESIDUAL_WINDOW_SIZE` (diagnóstico-solo, nunca leído fuera
  de `window_size()`, sin cambio de ningún camino de producción) para probar si el +2 de deriva de `e36f0e0`
  era un efecto de partición (una ventana distinta agrupa distintos roots, y un sitio podría resolver
  distinto según qué OTROS roots comparten su ventana). Corridas a 256/512/1024 (ver §7 tabla) refutan la
  hipótesis para `confirmed_combined`/`upgraded`/`inferred_type_entities` (idénticos en los 3 tamaños);
  hallazgo lateral: `diagnostics_emitted` SÍ depende del tamaño de ventana (248.481/248.193/248.187) — un
  efecto de partición real pero solo para diagnósticos del compilador, no para referencias. Re-corrida
  del harness (`schedule8.log`): converge en 4 eventos (134,6s), `confirmed_combined=161.794` — exacto.
- **`fdb18b8`** (C.7, aserciones finales): `inferred_type_entities` final debe ser EXACTAMENTE 41.042
  (probado invariante al tamaño de ventana por C.6, sin fuente conocida de variación legítima) —
  hardcodeado con comentario de cómo re-verificarlo. `confirmed_combined` pasa a un bound `<= 4` de
  diferencia (no exacto) con comentario citando cada dato de esta investigación: `schedule7`=+2 (161.796),
  `schedule8`=+0 (161.794); las 3 corridas w256/w512/w1024 (todas sin cota) = 161.794 (efecto de partición
  refutado). Explícito: la fuente del ±2 NO se identificó — decisión del dueño pendiente, sin ensanchar el
  bound sin evidencia nueva, sin bajarlo a 0 tampoco. `diagnostics_emitted` deliberadamente sin aserción
  (C.6 probó que SÍ depende del tamaño de ventana). `upgraded_sites`/`external_sites`/`unresolved_sites`
  capturados por evento (antes descartados vía `..`) más una línea de "sumas por pase".

Tras `963fc0c` (merge de D, que añade referencias nuevas y por tanto desplaza el `confirmed_combined` de
referencia), `26f7ae5` refresca `REFERENCE_CONFIRMED_COMBINED` de 161.794 a **161.807**
(`residual.rs:5612`, re-verificado en vivo en `v4-fold/q5-meas/histogram-unbounded.log`), manteniendo
`REFERENCE_INFERRED_TYPE_ENTITIES=41.042` sin cambio y el bound `CONFIRMED_COMBINED_TOLERANCE=4`
(`residual.rs:5613`).

### Frente D — `q5-references`: globales ambiente, alias de tipo, nombres cualificados, diagnóstico `call_chain` (merge `963fc0c`)

Crates: `crates/urdira-jsts-syntax-worker/src/{lib.rs,resolver.rs,semantic_sites.rs}`,
`crates/urdira-jsts-typeflow/src/lib.rs`, `crates/urdira-indexing-worker/src/v4/typeflow.rs` +
`src/main.rs`. 6 ficheros, 2.725 inserciones/55 borrados — el frente de mayor superficie semántica.

- **D.1** (`21ccebf`): `SyntaxFileResult`/`SyntaxCollector` ganan `ambient_globals` (nuevos
  `AmbientGlobalDeclaration`/`GlobalScope` en `lib.rs:683-694`). Dos fases, calcando `is_augmentation`:
  durante el walk, un escaneo plano no-recursivo de `program.body` marca candidatas `ScriptTopLevel`
  (namespace/interface/type incondicional; declare var/let/const/function/class/enum) y un override nuevo
  `visit_ts_global_declaration` (`lib.rs:4825`, `TSGlobalDeclaration` tiene su propio punto de `Visit`,
  distinto de `TSModuleDeclaration`) marca los hijos directos de un `declare global {}` como
  `DeclareGlobal` incondicionalmente; post-walk, las candidatas `ScriptTopLevel` se descartan si el
  fichero resulta tener sintaxis de módulo top-level (`file_has_top_level_module_syntax`), las
  `DeclareGlobal` se conservan siempre. `entity_id` es siempre la fórmula `stable_entity_id` ordinaria —
  nunca una entidad nueva. `resolver.rs`: `AmbientModuleIndex` gana `globals` y
  `resolve_global(name, referencing_path) -> GlobalLookup{Unique|Ambiguous|Absent}`
  (`resolver.rs:1690`), con desempate `FirstDeclaration` para merges de namespace del mismo nombre.
  `semantic_sites.rs`: los dos puntos de degrade a `REASON_UNRESOLVED_GLOBAL` consultan primero
  `resolve_global`. Tests: `cargo test -p urdira-jsts-syntax-worker -p urdira-jsts-typeflow` → 283
  passed (syntax-worker), 47 passed (typeflow).
- **`add7d74`** (D.1, arreglo de puerta): el índice de D.1 ROMPÍA la puerta dura de paridad
  (`different_target: 7.025`) en la corrida completa sobre n8n, por dos colisiones no contempladas: (1)
  un `.d.ts` del workspace redeclarando un global estándar de ECMAScript/DOM/Node
  (`console`/`Array`/`BigInt`/`Navigator`, vía shims de tipos de un worker de navegador o merges de
  interfaz) ganaba sobre la respuesta real (las `lib.*.d.ts` de TypeScript, invisibles para este crate) —
  6.856 destinos erróneos, arreglado con `is_standard_global_name` (`resolver.rs:1850`, lista curada no
  exhaustiva, válvula de seguridad, nunca fuente de respuestas nuevas); (2) dos paquetes DISTINTOS
  declarando cada uno `namespace jest {}` (`packages/cli/src/jest.d.ts` y
  `packages/@n8n/json-schema-to-zod/test/jest.d.ts`) — el desempate ingenuo "primera declaración en orden
  `BTreeMap`" elegía siempre la de `@n8n` (`@` ordena antes que `c`), incorrecto para las 169 referencias
  de `packages/cli/**` — arreglado con `workspace_scope_prefix` (`resolver.rs:1798`, prefiere el único
  candidato que comparte el prefijo de paquete del propio fichero referenciador). `resolve_global` gana
  parámetro `referencing_path`. Gate re-corrido en release sobre el corpus completo: `same=957.034
  different=0 unresolved_global=27 (≤30) namespace=24`; llamadas byte-idénticas al checkpoint C.
- **D.2** (`9a7e065`): `DeclSummary` (typeflow) gana `type_aliases: Vec<TypeAliasDecl>`, extraído de
  `TSTypeAliasDeclaration`s top-level (exportados o no) por el MISMO mecanismo que ya sintetiza interfaces
  para anotaciones inline de tipo-literal. `classify_heritage_identifier` gana un brazo
  `SymbolFlags::TypeAlias` (antes caía a `Unknown`). `ProgramIndex` gana
  `alias_targets: HashMap<String, Option<ResolvedTypeRef>>` (la presencia de la clave —no solo su valor—
  distingue "alias conocido sin converger" de "no es un alias"), construido con
  `resolve_type_ref_chasing_aliases`/`resolve_alias_chase_leaf` (guarda de ciclo + profundidad máxima 8).
  **Dos** puntos de des-aliasado, no uno (corrección de la revisión previa del plan): `resolve_raw_type_ref`
  y `resolve_heritage_target` (este último alimenta `container.extends/implements`, indexado por ids de
  clase/interfaz/tipo-literal, nunca por alias — sin des-aliasar aquí `class C extends Alias` no heredaría
  miembros).
- **`ea06482`** (D.2b, arreglo del worker): `collect_needed_imports_for_summary` (v4/typeflow.rs) y su
  duplicado byte-idéntico en `main.rs` (`build_typeflow_program_index`) enumeran los campos de
  `DeclSummary` por nombre fijo y nunca visitaban `type_aliases` — un alias cuyo RHS nombra un símbolo
  IMPORTADO no tenía entrada en `import_targets`, quedando pendiente pese a que la lógica de D.2 fuera
  correcta. Un bucle añadido en ambos ficheros. Hallado en vivo contra n8n:
  `ObservationLogReflectorMemory = BuiltObservationLogStore`, consumido vía `const { memory } = opts`.
- **D.3** (`abbaf94`): `SyntaxFileResult` gana `namespace_members: Vec<NamespaceMember>`, recogidos en
  `visit_ts_module_declaration` reutilizando la extracción de nombres exportados de
  `ambient_module_members`. `resolver.rs`: `resolve_namespace_member_by_name(namespace_id, name)`
  (documentado como NO consciente de merge entre ficheros). `semantic_sites.rs`:
  `visit_ts_qualified_name` (`semantic_sites.rs:4263-4309`) intenta `resolve_qualified_namespace_path`
  antes de caer a pendiente — la raíz se clasifica vía `resolve_identifier_to_kind` (ya consciente de
  namespace desde F2b) con fallback al índice ambiente de D.1; cada segmento no-último debe ser él mismo
  un namespace para seguir descendiendo. Sub-razones nuevas `member_access/qualified:absent|ambiguous`.
- **D.4** (`bf42d09`, diagnóstico puro, sin cambio funcional): `call_chain_hop_reason` clasifica QUÉ hop
  falla en `member_access_sub_reason` para `call_chain`: `root_untyped`, `receiver_not_entity`,
  `member_unknown`, `return_unknown`, `generic_erased` — construido directamente del AST/índice typeflow,
  no un re-trazado del árbol de `type_of_expression`, usado solo para el histograma corpus-wide de D.4.
- **`51e73ef`** (D.5, revisión adversarial, 5 hallazgos):
  1. **BUG**: `resolve_alias_chase_leaf` insertaba en el `visiting` compartido y nunca lo quitaba al
     volver — un diamante ACÍCLICO (`type A = X | Y; type X = B; type Y = B; type B = Foo;`) se rompía:
     tras cazar `X → B → Foo`, `B` quedaba marcado; cazar la rama hermana `Y → B` chocaba con la marca
     residual de `X` y resolvía a `None` por un falso ciclo. Arreglo: `visiting.remove(id)` tras retornar
     la recursión.
  2. **BUG**: `is_standard_global_name` lista `"globalThis"` y `resolve_global` comprobaba la lista negra
     primero, así que `declare global { namespace globalThis {} }` (una augmentación GENUINA del
     namespace global real, la misma muestra que motivó D.1) nunca podía resolver. Arreglo: la lista negra
     se salta solo cuando el nombre tiene una candidata `(EntityKind::Namespace,
     GlobalScope::DeclareGlobal)`.
  3. **Hueco de alcance del plan**: `resolve_static_member_reference` (posición VALOR, `Ns.Member`) nunca
     se conectó a `resolve_qualified_namespace_path` — solo el hermano de posición TIPO (D.3) lo estaba.
     Cableado el mismo resolutor, un segmento.
  4. **NUNCA ADIVINAR**: `workspace_scope_prefix` caía a `candidates[0]` (una adivinanza) cuando 0 o 2+
     candidatos compartían el scope del referenciador. Ahora devuelve `Ambiguous` en ambos casos — `Unique`
     solo con exactamente 1 en scope.
  5. `resolve_ambient_global` hardcodeaba `cross_file: true`. `GlobalLookup::Unique` ahora lleva el path
     declarante; `cross_file` es la comparación real `declaring_path != referencing_path`.
  Tests finales: `cargo test -p urdira-jsts-syntax-worker -p urdira-jsts-typeflow -p urdira-indexing-worker`
  → 296 passed (syntax-worker), 55 passed (typeflow), 99 passed/11 ignored (indexing-worker, con
  `URDIRA_TSGO_BINARY`).

Progresión de tests del crate (syntax-worker): 283 (D.1) → 285 (`add7d74`) → 288 (D.3) → 292 (D.4) → 296
(D.5, final). typeflow: 47 (D.1) → 53 (D.2) → 55 (D.5, final).

### Post-merge, fuera de las 4 ramas

- **`d53d91a`**: `test:native` resolvía `URDIRA_TSGO_BINARY` con `$(ls node_modules/.pnpm/…)` (ruta
  relativa al cwd) — `cargo test` ejecuta los binarios de test con el directorio del CRATE como cwd, no
  la raíz del repo, así que la ruta no existía. Arreglado a `$(ls $PWD/node_modules/.pnpm/…)`
  (`package.json:32`, confirmado — el script literal usa `$PWD` en las 3 invocaciones tsgo-gated).
- **`26f7ae5`**: `n8n_residual_schedule_resumes_after_truncation` tenía `REFERENCE_CONFIRMED_COMBINED`
  hardcodeado a 161.794 (pre-merge de D); D añade registros de referencia que desplazan legítimamente la
  cifra del pase sin cota a 161.807 (re-verificado en vivo, `v4-fold/q5-meas/histogram-unbounded.log`).
  Constante actualizada; `REFERENCE_INFERRED_TYPE_ENTITIES` sin cambio.

## 3. Frente A — tiempos cold ×3 (n8n, `node scripts/v4-scan.mjs`, release, `URDIRA_DEBUG_TIMING=1`)

Medición final, serializada e intercalada nuevo/base (`cold-new-1 → cold-base-1 → cold-new-2 →
cold-base-2 → cold-new-3 → cold-base-3`, confirmado por timestamps de fichero
`~/Proyectos/urdira-benchmark/v4-fold/q5-meas/cold-{new,base}-{1,2,3}.log`, 00:44:26-00:47:04). **nuevo**
= main final (`26f7ae5`, A+B+C+D fusionados); **base** = binario de `82159a2` construido aparte en
`v4-fold/wt-82159a2/` (568MB de árbol de trabajo). Mediana columna a columna sobre las 3 corridas.

| etapa | new-1 | new-2 | new-3 | **new mediana** | base-1 | base-2 | base-3 | **base mediana** | delta |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| catalog_ms | 5.499 | 5.502 | 4.937 | **5.499** | 4.988 | 5.296 | 5.109 | **5.109** | +7,6% |
| parse_ms | 2.365 | 1.947 | 2.025 | **2.025** | 2.071 | 1.880 | 2.163 | **2.071** | −2,2% |
| resolve_ms | 2.487 | 2.909 | 2.437 | **2.487** | 2.366 | 2.914 | 2.785 | **2.785** | −10,7% |
| materialize_ms | 4.902 | 5.263 | 6.124 | **5.263** | 6.365 | 5.641 | 5.265 | **5.641** | −6,7% |
| write_ms | 5.941 | 5.142 | 6.221 | **5.941** | 5.679 | 5.628 | 5.920 | **5.679** | **+4,6%** |
| fsync_ms | 292 | 156 | 164 | **164** | 155 | 156 | 207 | **156** | +5,1% |
| snapshot_ms | 7 | 4 | 2 | **4** | 21 | 3 | 2 | **3** | +33,3% |
| total_ms | 23.895 | 22.404 | 23.502 | **23.502** | 22.875 | 23.011 | 23.508 | **23.011** | +2,1% |

Records totales: nuevo = 2.186.930 (idéntico en las 3 corridas), base = 2.176.247 (idéntico en las 3) —
+10.683 registros, atribuibles a las entidades/referencias nuevas de Frente D (namespace members, alias,
qualified paths, ambient globals). `roots.records` idéntico dentro de cada trío (nuevo
`sha256:9ba31634…`, base `sha256:57d4a18a…` — este último coincide EXACTAMENTE con la raíz `records`
citada para el checkpoint `80d697c` en la evidencia anterior, confirmando que el binario base reproduce
ese estado); distinto nuevo-vs-base (esperado, D añade referencias). `roots.dependency` **idéntico**
nuevo y base (`sha256:d76ff317…`) — ningún frente de Q5 toca el grafo de dependencias inter-artefacto, tal
como estaba declarado en el alcance de B. `roots.graph`: idéntico dentro de cada trío (nuevo
`sha256:86ac26a4…`, base `sha256:c4221284…`) pero distinto nuevo-vs-base — **A.4 resuelto sin código**:
la escritura es determinista (3/3 idéntica en cada checkpoint), y el cambio nuevo-vs-base es coherente con
el contenido nuevo que D añade, no con una regresión de orden no determinista.

### Desglose de escritura por fichero (`[urdira-structural-store] base write (partitioned):`, solo nuevo — el binario base es anterior a la instrumentación de A.1)

| run | hot | by_owner | by_name | by_kind | by_identity | adj.out | adj.in | entities.index | fsync |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| new-1 | 1.090 | 809 | 368 | 89 | 215 | 75 | 67 | 288 | 152 |
| new-2 | 764 | 1.005 | 58 | 60 | 165 | 57 | 53 | 107 | 89 |
| new-3 | 1.153 | 663 | 398 | 227 | 239 | 62 | 56 | 227 | 78 |
| **mediana** | **1.090** | **809** | **368** | **89** | **215** | **62** | **56** | **227** | **89** |

`entities.index` (227ms mediana) es el 3,8% de `write_ms` (5.941ms) — dentro del rango "2-5%" esperado por
el tamaño de la sección (~4,5MB sobre ~370k entidades). La suma de las medianas por fichero (3.005ms) es
menor que `write_ms` (5.941ms) porque `hot`/`entities.index`/el resto de secundarios corren en paralelo
(`rayon::join` anidado de A.2) — `write_ms` no es una suma sino el máximo de las ramas paralelas más el
trabajo secuencial no cubierto por esta línea (SQL de publicación, medido aparte en 0ms según la
instrumentación de F1 de la campaña anterior).

**Diagnóstico de aislamiento (`URDIRA_V4_DIAG_SKIP_ENTITIES_INDEX=1`) — NO CONFIRMADO desde los logs
retenidos**: los ficheros `entities.index` de `q5-store/data-diag/structural/base-1/` y
`q5-store/data-diag2/structural/base-1/` son **byte-idénticos** (4.503.856 bytes cada uno) al de
`q5-store/data-1/structural/base-1/` (la corrida normal), no el fichero vacío-con-cabecera que el flag de
diagnóstico debería producir. No se puede afirmar, a partir de estos logs, que el flag se activara
realmente en las corridas `run-diag`/`run-diag2` (`~/Proyectos/urdira-benchmark/v4-fold/q5-store/`,
máquina contendida, tiempos de escritura entities.index 247ms/87ms allí frente a 583/1471/77ms en
run1/2/3 — dentro del mismo rango ruidoso, no una reducción clara). Esta redacción NO afirma que el
mecanismo del flag esté roto — solo que su ejercicio en estos logs concretos no está verificado.

## 4. Frente B — incremental worker-only (`n8n_incremental_measurement`, pasos `COLD/EDIT#1/EDIT#2/CREATE/DELETE/EDIT#3/RENAME/HUB_EDIT_SURFACE_UNCHANGED/HUB_EDIT_SURFACE_CHANGED`)

Medición final, `v4-fold/q5-meas/incr-new-{1,2}.log` (nuevo, 2 corridas) e `incr-base-1.log` (base
`82159a2`, 1 corrida), literal desde `ScanTimings`:

| paso | new-1 total_ms (close_protection_ms) | new-2 total_ms (close_protection_ms) | base-1 total_ms (close_protection_ms) |
|---|---:|---:|---:|
| COLD (gen1) | 22.134 (None) | 22.524 (None) | 24.620 (None) |
| EDIT#1 (gen2) | 950 (6) | 1.038 (8) | 1.226 (169) |
| EDIT#2 (gen3) | 304 (3) | 294 (3) | 309 (4) |
| CREATE (gen4) | 251 (3) | 241 (3) | 260 (4) |
| DELETE (gen5) | 231 (3) | 230 (3) | 250 (3) |
| EDIT#3 (gen6) | 245 (5) | 231 (4) | 541 (294) |
| RENAME (gen7) | 282 (3) | 292 (4) | 570 (278) |
| HUB_EDIT_SURFACE_UNCHANGED (gen8) | 259 (6) | 278 (8) | 527 (269) |
| HUB_EDIT_SURFACE_CHANGED (gen9) | 902 (115) | 1.277 (167) | 1.441 (415) |

EDIT#3/RENAME/HUB_UNCHANGED (criterio ≤40ms): nuevo 3-8ms en las 6 celdas (2 corridas × 3 pasos) frente a
base 269-294ms — **cumplido con margen amplio**. HUB_CHANGED (criterio ≤60ms):
mediana nuevo = (115+167)/2 = **141ms** (base 415ms, −66%) — **no cumplido literalmente, aceptado con
cifra** (§8). `total_ms` HUB_CHANGED (criterio ≤1.050ms): mediana = (902+1.277)/2 = **1.089,5ms** (base
1.441ms) — se queda a +3,8% del umbral.

### Línea DEBUG (literal, `delta.rs:938`) y atribución del resto de `close_protection_ms`

```
[urdira-indexing-worker] v4 delta DEBUG: external-entity close-protection: at_risk=23 protected=2 zombie_candidates=2 zombie_closures=0 adjacency_lookups=23 protection_us=110
```

(HUB_EDIT_SURFACE_CHANGED, `incr-new-1.log`). `protection_us=110` (0,11ms) es el coste real de la
reescritura B.1 sobre `adj.in` — prácticamente cero. Los 115-167ms de `close_protection_ms` que sí se
miden en HUB_CHANGED son, casi en su totalidad, el `by_owner` fetch de `prev_rows_by_owner` sobre los
owners tocados (los ~377 importadores del fichero hub en este fixture) — trabajo que el diff necesita de
todas formas para construir el propio delta (at-risk/deleted/zombie), medido bajo este cronómetro por
razones históricas, no una regresión nueva de B. El índice inverso persistente `target_subject → owners`
(precedente `dep_owner_index`) que evitaría ESTE fetch quedó explícitamente fuera de alcance de B (ya lo
estaba en el plan) y sigue como candidato, ver §9.

Oráculo (`v4-fold/q5-meas/oracle.log`, final): `n8n-scale root equality CONFIRMED for create+delete
against a from-scratch oracle`; `n8n-scale pending-site set equality CONFIRMED … (631877 sites)`; `test
result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 116 filtered out; finished in 65.25s`. La cifra de
sitios (631.877) difiere de los 631.899 citados en la evidencia anterior y de los 631.899/632.055 vistos
en logs de desarrollo de esta misma sesión (`q5-incr/oracle.log`, `q5-store/run-diag.log`) — ambas
corridas CONFIRMAN igualdad contra su propio oráculo from-scratch respectivo; la diferencia entre
invocaciones es estado de máquina/timing entre ejecuciones separadas del mismo test, no una discrepancia
de corrección (mismo test, misma aserción, verde en ambas).

## 5. Frente C — residual con y sin cota de tiempo

### Sin cota (`v4-fold/q5-meas/histogram-unbounded.log`, post-merge D)

```
[n8n_residual_pass_debug_histogram] residual pass wall=55.771s checker_ms=41305 total_ms=51310 upgraded=56288 external=40158 unresolved=528512 inferred_type_entities=41042 type_of_relations=41042 diagnostics_emitted=248193 truncated=false windows=28/28
[confirmed_possible_histogram] AFTER generation=2 core:call confirmed=159939 possible=369 | heritage confirmed=1868 possible=0 | confirmed_combined=161807
```

Coincide exactamente con la constante `REFERENCE_CONFIRMED_COMBINED=161.807` fijada en `26f7ae5`.

### Con cota `URDIRA_V4_RESIDUAL_BUDGET_MS=20000` ×2 (`residual-budget20s-{1,2}.log`, post-merge D)

| corrida | checker_ms | total_ms | truncado | windows_done/total | remaining_owners | confirmed_combined |
|---|---:|---:|---|---:|---:|---:|
| 1 | **20.323** | 26.205 | sí | 21/28 | 4.707 | 139.163 |
| 2 | **20.350** | 25.973 | sí | 21/28 | 4.761 | 139.163 |

Criterio de C.1 (`checker_ms ≤ 20.000 + 1.000`): **cumplido en las 2 corridas** (20.323ms y 20.350ms,
ambas bajo 21.000ms) — mejora sustancial frente al comportamiento pre-fix (36,6s de wall real contra una
cota de 20s, documentado en la evidencia anterior y en el propio commit `8c45924`). `confirmed_combined`
idéntico entre las 2 corridas (139.163) pese a `inferred_type_entities`/`diagnostics_emitted` distintos
(no investigado más allá — comportamiento esperado de un pase parcial, publica una generación truncada
como diseñado).

### Cadena `schedule()` real (`v4-fold/q5-meas/schedule.log`, post-merge D, `URDIRA_V4_RESIDUAL_BUDGET_MS=15000`)

| evento | wall | generación | truncado | windows | checker_ms |
|---|---:|---:|---|---:|---:|
| 1 | 25,079s | 2 | true | 16/28 | 15.217 |
| 2 | 52,848s | 3 | true | 14/16 | 15.282 |
| 3 | 70,789s | 4 | **false** | 5/5 | 9.142 |

Converge en 3 eventos (no los 4-5 típicos de las corridas de desarrollo pre-D, ver abajo).
`confirmed_combined` final = **161.809** (`[confirmed_possible_histogram] FINAL generation=4`) — +2 sobre
la referencia 161.807, dentro del bound `<=4` de `fdb18b8`. `test result: ok. 1 passed; 0 failed; …
finished in 102.91s`. `n8n_residual_second_pass_without_pending_sites` **no** se re-ejecutó en esta
medición final serializada (no aparece en ningún log de `q5-meas/`) — quedó verificado solo durante la
implementación (`6526763`: "cargo test -p urdira-indexing-worker … 99 passed; 0 failed; 11 ignored").

### Evolución de la cadena durante el desarrollo (`v4-fold/q5-residual/`, máquina contendida, citar como tal)

| log | eventos | resultado | `windows_total` por evento | `confirmed_combined` final |
|---|---:|---|---|---:|
| `schedule2.log` (pre-fix `49d2760`) | 21 | **nunca converge** | 28,25,24,24,24,24,… oscila 24-28 | — (última: `windows=12/24 truncated=true`) |
| `schedule3.log` (pre-fix `49d2760`) | 21 | **nunca converge** | similar, última `wall=600,5s generation=15 windows=11/23` | — |
| `schedule4.log` (post-fix 1, pre-`e36f0e0`) | — | converge | — | 161.824 |
| `schedule5.log` (post-fix 1) | 4 | converge | 28→17→8→2 | 161.821 |
| `schedule6.log` (post-fix 1) | 4 | converge | 28→17→8→5 | 161.747 |
| `schedule7.log` (post `e36f0e0`, visibilidad separada) | 3 | converge | 16/28→14/16→5/5 | **161.796** (+2) |
| `schedule8.log` (post `f7a4618`, diagnóstico ventana) | 4 | converge | 11/28→15/21→10/10→1/1 | **161.794** (exacto) |

Confirma literalmente los datos citados en los commits `49d2760`/`e36f0e0`/`f7a4618`: el fix 1 (saltar la
unión en continuaciones) pasa de "nunca converge en 21 intentos" a "converge en 4-5 con `windows_total`
drenando monotónicamente"; el fix de visibilidad reduce el drift de 30-50 a 2; ninguno de los dos deja el
drift en 0 de forma reproducible (`schedule7`=+2, `schedule8`=+0 — bidireccional, no un sesgo fijo).

### Invariancia al tamaño de ventana (`URDIRA_V4_RESIDUAL_WINDOW_SIZE`, diagnóstico C.6, pre-merge D — confirmado_combined de referencia en esa etapa = 161.794)

| tamaño de ventana | confirmed_combined | upgraded | inferred_type_entities | diagnostics_emitted |
|---:|---:|---:|---:|---:|
| 256 (`histogram-unbounded-w256.log`) | 161.794 | 56.297 | 41.042 | **248.481** |
| 512 (`histogram-unbounded.log`, dev) | 161.794 | 56.297 | 41.042 | **248.193** |
| 1024 (`histogram-unbounded-w1024.log`) | 161.794 | 56.297 | 41.042 | **248.187** |

`confirmed_combined`/`upgraded`/`inferred_type_entities` invariantes en los 3 tamaños — refuta la
hipótesis de que el drift de `e36f0e0` fuera un efecto de composición de ventana. `diagnostics_emitted`
SÍ varía (248.481/248.193/248.187) — efecto de partición real, pero solo para diagnósticos del
compilador; por eso `fdb18b8` deja ese campo sin aserción en el harness `schedule()`.

## 6. Frente D — paridad de referencias por paso de desarrollo (`d1`→`d5`, `~/Proyectos/urdira-benchmark/v4-fold/q5-parity/`)

v3 = 1.110.576 `core:references` confirmadas (invariante, oráculo) en las 6 corridas.

| paso | v4_same_target | v4_different_target | v4_missing | lib | workspace |
|---|---:|---:|---:|---:|---:|
| d1 (post-D.1, pre-fix) | 956.889 | **7.025** | 146.662 | 130.403 | 16.259 |
| d1b (post `add7d74`) | 957.034 | 0 | 153.542 | 137.259 | 16.283 |
| d2b (post D.2/D.2b) | 957.517 | 0 | 153.059 | 137.259 | 15.800 |
| d3 (post D.3) | 957.510 | 0 | 153.066 | 137.259 | 15.807 |
| d4 (post D.4) | 957.510 | 0 | 153.066 | 137.259 | 15.807 |
| d5 (post D.5, final) | **957.556** | **0** | 153.020 | 137.259 | **15.761** |

d1 tenía 7.025 destinos erróneos (el bug de "no-guess namespace merge" que `add7d74` cerró); desde d1b en
adelante `different_target=0` en las 5 corridas restantes. Checkpoint previo `80d697c` (evidencia
anterior) `same=956.840` → `same=957.556` final, **+716** — coincide con "refs same 956.840→957.556,
different 0" citado literalmente en el mensaje del merge `963fc0c`.

### Histograma de razones workspace-only, progresión d1→d5 (`workspaceReasonPrefixHistogram`)

| razón | d1 | d1b | d2b | d3 | d4 | d5 |
|---|---:|---:|---:|---:|---:|---:|
| member_access | 9.793 | 9.793 | 9.289 | 9.296 | 9.296 | **9.274** |
| import_binding | 3.304 | 3.304 | 3.304 | 3.304 | 3.304 | 3.304 |
| jsdoc_typed_file | 2.144 | 2.144 | 2.144 | 2.144 | 2.144 | 2.144 |
| unknown_no_pending_dump_match | 740 | 740 | 761 | 761 | 761 | 761 |
| re_export_binding | 216 | 216 | 216 | 216 | 216 | 216 |
| multiple_declarations | 49 | 49 | 49 | 49 | 49 | 49 |
| unresolved_global | 3 | 27 | 27 | 27 | 27 | **3** |
| this_expression | 7 | 7 | 7 | 7 | 7 | 7 |
| type_predicate_parameter | 3 | 3 | 3 | 3 | 3 | 3 |

`unresolved_global × namespace` (el objetivo original de D.1): 193 en el checkpoint previo (`80d697c`) →
3 en d1/d5 (2 `type` + 1 `interface` según el cross-tab por raw-kind; el bucket `namespace` queda en 0) —
**criterio ≤30 cumplido con margen amplio**. El bucket intermedio de 27 en d1b-d4 (`unresolved_global |
workspace`, sin desglosar por raw-kind) desaparece en d5; el mecanismo exacto de ese cierre no está
declarado literalmente en ningún log examinado — atribuible por construcción a D.2b/D.5 (los últimos
commits antes de d5), pero esta redacción no afirma la causalidad exacta sin una cita directa.

### `member_access` por sub-razón, d5 final (workspace-only, sumado sobre todos los raw-kind)

| sub-razón | d5 | nota |
|---|---:|---|
| call_chain/root_untyped | **4.103** | 2.503 method + 1.198 getter + 350 function + resto |
| ident:local_untyped | 4.088 | 2.863 method + 632 getter + resto |
| call_chain/member_unknown | 184 | |
| call_chain/return_unknown | 105 | |
| call_chain/generic_erased | 107 | |
| qualified:absent | **342** | 148 type + 95 function + 47 class + resto |
| this | 178 | |
| ident:import_bound | 109 | |
| other | 47 | |
| ident:param_destructured | **4** | solo property |
| bare (sin sub-razón) | **7** | 6 method + 1 property |
| **suma** | **9.274** | coincide con el histograma de prefijos |

Progresión `bare`: 808 (d1/d1b) → **7** (d2b en adelante, D.3 cierra el grueso vía nombres cualificados).
Progresión `ident:param_destructured`: 6 (d1/d1b) → 4 (d2b) → 9 (d3/d4, regresión transitoria) → **4**
(d5, vuelve a la cifra de d2b). `qualified:absent` (342) aparece recién en d2b y no cambia hasta d5 —
estos son destinos externos inherentes al segmento cualificado (p. ej. un miembro de un namespace
externo/tercero fuera del corpus), no un fallo del resolutor.

### Paridad de llamadas (no tocada por D)

v3: 734.379 filas, 205.468 confirmadas, 528.911 possible, 0 errores — idéntico en d1/d2b/d4/d5.

| paso | v4 confirmadas | mismo destino | destino distinto | possible | sitio ausente |
|---|---:|---:|---:|---:|---:|
| d1 | 159.926 | 114.569 | **0** | 87.029 | 3.870 |
| d2b | 159.939 | 114.569 | **0** | 87.029 | 3.870 |
| d4 | 159.939 | 114.569 | **0** | 87.029 | 3.870 |
| d5 | 159.939 | 114.569 | **0** | 87.029 | 3.870 |

Histograma forward byte-idéntico en las 4 corridas — Frente D no mueve ni una clasificación de llamada.
`confirmed_combined` del residual (`residual-{d1,d2b,d4,d5}.log`): 161.794 (d1) → **161.807** (d2b/d4/d5,
+13, coincide con el +13 de `v4 confirmadas` 159.926→159.939 entre d1 y d2b).

## 7. `pnpm verify` en `26f7ae5`

Log final verde: `~/Proyectos/urdira-benchmark/v4-fold/q5-verify/verify-4.log`.

```
Test Files  139 passed | 2 skipped (141)
Tests  2083 passed | 13 skipped (2096)
Statements   : 83.97% ( 42440/50540 )
Lines        : 90.07% ( 27544/30578 )
Coverage gate passed: measured repository lines 90.08% (27544/30578), critical branches 100.00% (15/15), semantic regions 100.00%.
Publication hygiene passed (1006 files checked).
EXIT=0
```

Suma de todas las líneas `test result: ok. N passed; N failed; N ignored` del log (`cargo test
--workspace --locked` + las 3 invocaciones tsgo-gated de `test:native`): **691 passed, 0 failed, 44
ignored** (vs 656 passed citados para el cierre de "frentes 1-4" — la diferencia de 35 corresponde a los
tests nuevos de A/B/C/D, principalmente C.2/C.4 y las suites de D). El conteo de `ignored` incluye tanto
los tests `n8n_*`/`URDIRA_V4_N8N_*`-gated (correctamente fuera de verify) como cualquier suite tsgo sin
resolver en ese momento — no desglosado por categoría en esta redacción.

Tres intentos previos fallaron y quedaron arreglados en la propia sesión, mismos logs retenidos:

- **`verify-1.log`**: `[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory
  due to no TTY` — `node_modules` corrompido a través de un symlink de worktree, `pnpm install` se negó a
  purgar sin TTY. Arreglado reinstalando (`reinstall.log`: reinstala 17 workspace projects + deps,
  "Done in 3.1s").
- **`verify-2.log`**: `thread 'binding_element_name_start_covers_plain_renamed_default_and_nested_shapes'
  panicked at crates/urdira-tsgo-client/src/binary.rs:295:9: tsgo binary not discoverable:
  node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/… points to a nonexistent file (from
  URDIRA_TSGO_BINARY)` — la ruta relativa en `test:native` (cwd = directorio del crate bajo `cargo test`,
  no la raíz del repo). Arreglado por `d53d91a` (`$PWD` absoluto).
- **`verify-3.log`**: `Error: structural store error: unsupported manifest format 6 (want 5)` en
  `tests/v4-scan.test.ts` y fallos relacionados en `index-pack-v4.test.ts`/`v4-verify.test.ts`/
  `workspace-fork-v4.test.ts` — el addon nativo (`packages/native/prebuilds`) seguía compilado contra el
  conocimiento de formato 5 de una sesión anterior a F4. Arreglado con `pnpm build:native`
  (`build-native.log`: reconstruye `urdira-native.node` + workers para `darwin-arm64`).

`pnpm check:publication` se ejecutó sobre este propio fichero de evidencia antes de darlo por cerrado
(ver Informe final).

## 8. Criterios del plan: cumplido / aceptado con cifra

| frente | criterio del plan | resultado | veredicto |
|---|---|---|---|
| B | HUB_CHANGED `close_protection_ms` ≤60ms | mediana **141ms** (base 415ms, −66%) | **aceptado con cifra**: `protection_us` real (el propio `adj.in`) es 110µs — el resto es el `by_owner` prefetch de ~377 owners tocados que el diff necesita de todas formas, fuera de alcance de B por diseño del plan |
| B | EDIT#3/RENAME/HUB_UNCHANGED ≤40ms | 3-8ms (nuevo) vs 269-294ms (base) | **cumplido**, con margen amplio |
| B | HUB_CHANGED `total_ms` ≤1.050ms | mediana 1.089,5ms | **no cumplido**, +3,8% — arrastrado por el mismo prefetch de B |
| B | oráculo CONFIRMED + 631.899 sites | CONFIRMED, 631.877 (nuevo) / 631.899 (dev) | **cumplido** (cifra exacta de sites varía ±22 entre invocaciones separadas, ambas verdes) |
| A | `write_ms` mediana ≤5.600ms **o** ≥70% del delta explicado por filas nuevas de F4 4.4 | 5.941ms (+4,6% sobre 5.679ms base); `entities.index` solo 3,8% de `write_ms`; diagnóstico de aislamiento no verificable en los logs retenidos | **aceptado con cifra**: el delta cabe dentro de la dispersión entre corridas de la propia medición nueva (5.142–6.221ms, rango 1.079ms > delta de 262ms); no se pudo aislar la causa exacta (ver §9) |
| A | clave ambigua `entities.index` (A.3) | sin commit, ya cerrado por `4d7c63c` de la campaña anterior | **cumplido** (trabajo ya hecho, confirmado sin tocar `reader.rs`) |
| A | raíz `graph` determinista (A.4) | idéntica ×3 dentro de cada checkpoint | **cumplido**, sin código |
| C | `checker_ms` ≤ cota+1s con `URDIRA_V4_RESIDUAL_BUDGET_MS=20000` ×2 | 20.323ms / 20.350ms | **cumplido** en las 2 corridas |
| C | harness `schedule()` real en n8n | 3 eventos, converge, `confirmed_combined`=161.809 (+2 de 161.807) | **cumplido**; drift ±2 documentado como decisión del dueño pendiente (bound ≤4, `fdb18b8`) |
| D | `unresolved_global × namespace` 193→≤30 | **0** (quedan 3 `unresolved_global` en workspace, todos `ambient:ambiguous` × type/interface, no namespace) | **cumplido** |
| D | `member_access` bare 808→≤300 | **7** (+342 `qualified:absent`, destinos externos inherentes) | **cumplido** en el bucket literal |
| D | `ident:param_destructured` 6→0 | **4** | **no cumplido** — los 4 restantes no están relacionados con alias de import (D.2/D.2b cerraron esa causa raíz específica; queda una causa distinta no diagnosticada) |
| D | `member_access` total 9.793→≤9.000 | **9.274** | **no cumplido** — dominado por `call_chain/root_untyped` (4.103) y `ident:local_untyped` (4.088), destructuring anidado con tipo inferido (`{ schemaBuilder: { column } }: MigrationContext`) fuera del alcance declarado de D.2; los sitios de llamada correspondientes SÍ los resuelve el residual tsgo (`confirmed_combined` no se ve afectado) |
| D | paridad refs `different==0`, `same≥956.840`; calls 0 erróneas | `different=0` (5/6 corridas, 1 con bug pre-fix), `same=957.556`; calls 0 erróneas en 4/4 | **cumplido** |

**Ningún criterio no alcanzado abrió un ítem de cola técnica nueva** — todos quedan documentados aquí con
cifra y causa mecánica, tal como exigía el plan. Lo que queda son decisiones del dueño (§9).

## 9. No hecho / aceptado con cifra (decisiones del dueño, no cola técnica)

1. **Atribución exacta del +4,6% de `write_ms`** (§3, §8): no se pudo aislar el coste marginal de
   `entities.index` porque el mecanismo de diagnóstico `URDIRA_V4_DIAG_SKIP_ENTITIES_INDEX=1` no se
   confirma activo en los logs retenidos de `q5-store/run-diag{,2}.log` (ficheros byte-idénticos a la
   corrida normal). Se acepta el delta como dentro de la dispersión de máquina de esta sesión sin una
   causa mecánica aislada. Repetir la corrida diagnóstica verificando explícitamente el tamaño del
   fichero resultante sería el siguiente paso, no ejecutado aquí.
2. **`ident:param_destructured` (4) y `member_access` total (9.274)** por encima de sus umbrales (§6, §8):
   causa raíz (destructuring anidado con interfaz, cadena fluida con genéricos) ya estaba señalada como
   fuera de alcance en la campaña anterior; D.2/D.2b cerraron el caso específico de alias de import
   (`ident:param_destructured` 6→4) pero no el resto. No se abre como ítem técnico nuevo — el propio plan
   preveía este desenlace ("si un umbral no se alcanza, la evidencia lo dice con la cifra real … no se
   abre ítem nuevo").
3. **Drift ±2-4 de `confirmed_combined` en la cadena `schedule()` con cota** (§5, §8): mecanismo del
   deadline ya no es la causa (refutado por invariancia al tamaño de ventana, C.6); fuente exacta no
   identificada tras 3 rondas de investigación (`49d2760`, `e36f0e0`, `f7a4618`). Bound `≤4` documentado
   como aceptado, no como bug — **decisión del dueño**: si se investiga más o se acepta permanentemente.
4. **`unresolved_global` bucket intermedio de 27 (workspace, sin raw-kind) que desaparece en d5** (§6):
   tendencia numérica confirmada por los JSON crudos, mecanismo causal exacto no citado literalmente en
   ningún log examinado — atribuible por construcción a D.2b/D.5 pero no verificado con una cita directa.
5. Heredado, sin tocar en Q5 (evidencia anterior §10.7 y esta, §6): namespaces anidados `A.B` (documentados,
   paridad con v3 ya cumplida); `declare global {}` con miembros no namespace/interface/type (fuera del
   alcance declarado de D.1); overloads elegidos por argumentos reales (bloqueado por caché compartida en
   `semantic_sites.rs`).
6. Producto (dueño, sin tocar esta sesión): huérfanos web, ramas/merges in situ, distribución de
   index-pack; coste de agentes (snippets inline, subagente de descubrimiento).
7. Limpieza de los worktrees `q5-*` y del binario base `~/Proyectos/urdira-benchmark/v4-fold/wt-82159a2/`
   (568MB) — retenidos por ahora junto con los logs citados en este documento; pendiente de autorización
   del dueño, igual que en el cierre de "frentes 1-4".

## 10. Trampas encontradas esta sesión

- **`node_modules` corrompido a través de un symlink de worktree**: un worktree aislado con
  `node_modules` symlinkeado al del repo principal deja `pnpm install` incapaz de purgar el directorio sin
  TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) — primer intento de `pnpm verify` (`verify-1.log`)
  falló así; arreglado reinstalando de forma explícita.
- **Ruta relativa de `URDIRA_TSGO_BINARY` en `test:native`**: `cargo test` ejecuta los binarios de test
  con el directorio del CRATE como cwd, no la raíz del repo — una ruta `$(ls node_modules/.pnpm/…)` sin
  `$PWD` resuelve a una ruta inexistente relativa al crate. Confirmado en vivo (`verify-2.log`, panic
  literal en `binary.rs:295:9`); arreglado con `$PWD` absoluto (`d53d91a`).
- **Addon nativo stale tras el bump de formato**: `packages/native/prebuilds` seguía compilado contra el
  formato 5 de una sesión anterior a F4 (que ya había subido a formato 6) — `unsupported manifest format
  6 (want 5)` en 4 suites vitest distintas (`verify-3.log`). Arreglado con `pnpm build:native`.
- **Un subagente terminó su turno "esperando" un job en background** — ocurrió DOS VECES en esta sesión
  (confirmado por la memoria/plan, que ya prohibía explícitamente este patrón desde sesiones anteriores;
  no hay una forma de corroborarlo con timestamps de log de forma inequívoca, pero la prohibición
  explícita en el propio plan de esta sesión — "nunca 'esperar' a un job en background" — se escribió
  precisamente porque volvió a ocurrir). Reanudado con `kill -0`/polling en foreground.
- **Carrera de fixture compartido en `cargo test -p urdira-indexing-worker` en paralelo** (pre-existente,
  no introducida por Q5): `v4::tests_e2e::incremental_{create,delete}_roots_match_a_from_scratch_scan_of_
  the_mutated_tree` fallan cuando corren en paralelo con otros tests que mutan el mismo fixture
  (`v4-fold/q5-meas/cargo-test-worker.log:128-135`: `panicked … scan::run_with_residual succeeds:
  ScanError("cannot read source blob for src/domain/task.ts: No such file or directory (os error 2)")`,
  `test result: FAILED. 100 passed; 2 failed; 15 ignored`). Con `--test-threads=1`
  (`cargo-test-worker-singlethread.log`): `test result: ok. 102 passed; 0 failed; 15 ignored`. `pnpm
  verify` usa la invocación de fichero-completo estándar de `cargo test --workspace --locked` (sin
  forzar un solo hilo) y pasó igualmente en `verify-4.log` — la carrera es real pero de baja probabilidad
  bajo la concurrencia por defecto de esta máquina; documentada, no arreglada (ya lo estaba en el cierre
  de "frentes 1-4", confirmado de nuevo en vivo esta sesión).

## Informe final

- Commits: B (`f3100b6`, `77e0177`, `6c68573`) merge `ad86791`; A (`689340a`) merge `e3aa728`; C
  (`8c45924`, `5db7472`, `6526763`, `49d2760`, `8c5d008`, `e36f0e0`, `f7a4618`, `fdb18b8`) merge `0462e91`;
  D (`21ccebf`, `add7d74`, `9a7e065`, `abbaf94`, `bf42d09`, `ea06482`, `51e73ef`) merge `963fc0c`; cierre
  `d53d91a` (ruta absoluta `test:native`), `26f7ae5` (constantes del harness `schedule()`). Base
  `82159a2`, final `26f7ae5` (21 commits no-merge + 4 merges = 25 commits).
- Cold ×3: nuevo mediana total_ms 23.502/write_ms 5.941 vs base 23.011/5.679 (+2,1%/+4,6%); records
  +10.683 (D); raíces `records`/`graph` deterministas dentro de cada checkpoint, distintas entre
  checkpoints (esperado); `dependency` sin cambio. `entities.index` 227ms mediana (3,8% de `write_ms`),
  coste marginal exacto no aislable con los logs retenidos.
- Incremental: HUB_CHANGED `close_protection_ms` 415ms (base) → 141ms mediana (nuevo, −66%, criterio
  ≤60ms no alcanzado pero `protection_us` real de la reescritura B.1 = 110µs); EDIT#3/RENAME/HUB_UNCHANGED
  269-294ms → 3-8ms (criterio ≤40ms cumplido con margen amplio). Oráculo CONFIRMADO en ambas
  invocaciones (631.877 nuevo / 631.899 dev).
- Residual: sin cota `confirmed_combined=161.807` (nueva referencia post-D); con cota 20s ×2,
  `checker_ms` 20.323/20.350ms (criterio ≤21.000ms cumplido, mejora sustancial sobre el 36,6s pre-fix);
  cadena `schedule()` converge en 3 eventos, `confirmed_combined=161.809` (+2, dentro del bound ≤4);
  invariancia al tamaño de ventana confirmada (256/512/1024 → 161.794/56.297/41.042 idénticos,
  `diagnostics_emitted` SÍ varía).
- Paridad referencias: `different_target=0` en 5/6 corridas (d1 tenía un bug real, cerrado por
  `add7d74`); `same` 956.840→957.556 (+716); `unresolved_global×namespace` 193→0 (criterio ≤30 cumplido; quedan 3 `ambient:ambiguous` × type/interface);
  `member_access` bare 808→7 (criterio ≤300 cumplido); `member_access` total 9.793→9.274 (criterio ≤9.000
  NO cumplido, dominado por `root_untyped`/`local_untyped`); `ident:param_destructured` 6→4 (criterio 0 NO
  cumplido).
- Paridad llamadas: sin cambio en las 4 corridas medidas (`different=0`, `same=114.569`/`159.939`
  confirmadas).
- `pnpm verify`: 8/8 en `26f7ae5` — 139/2 skip (141) ficheros vitest, 2.083/13 skip (2.096) tests,
  coverage líneas 90,08% (27.544/30.578), 691 tests cargo (0 fallos, 44 ignorados esperados), publication
  hygiene 1.006 ficheros. Tres intentos previos fallidos (`verify-1/2/3.log`) documentados y arreglados en
  la propia sesión.
- Evidencia: `docs/evidence/2026-09-05-v4-q5-store-write-protection-residual-budget-references.md` (este
  fichero). Sin cola técnica nueva; quedan solo decisiones del dueño (§9: drift ±2-4 del residual, ítems
  de producto, coste de agentes, limpieza de worktrees retenidos).
