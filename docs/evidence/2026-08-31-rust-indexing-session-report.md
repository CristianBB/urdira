# Informe consolidado de la sesión de optimización de indexación Rust

**Fecha de corte:** 2026-08-31  
**Repositorio:** `<repo-root>`  
**Corpus principal:** checkout de n8n, 14.236 archivos, 14.083 owners solicitados y 14.082 owners JS/TS descubiertos.

## 1. Resumen ejecutivo

Durante esta sesión se implementó una refactorización amplia para trasladar la coordinación de la indexación estructural desde TypeScript al core Rust. La ruta normal de producción ya no usa el writer estructural TypeScript: la aplicación captura fuentes/CAS, invoca un worker Rust persistente y Rust posee aceptación, staging, recibos, sellado, publicación SQLite, cancelación, recuperación, exclusión de escritores y mantenimiento lexical posterior.

El resultado es funcionalmente correcto en los casos ejercitados y conserva bytes canónicos, IDs, digests y formato SQLite v3. Sin embargo, el objetivo de tiempo del repositorio completo de n8n no se alcanzó. La ejecución cold completa más sólida terminó en **1.318.331 ms (21 min 58 s)** y la mutación registrada en **166.771 ms (2 min 47 s)**. Los resultados de 30--45 s corresponden a cortes de 512/1.000 owners, no al repositorio completo.

Este informe **no declara éxito de rendimiento ni P95**. Es un inventario de lo implementado, probado y medido para no repetir campañas ya agotadas.

## 2. Cambios implementados

### 2.1 Autoridad y arquitectura

- Se actualizaron README, índice de decisiones, decisiones 1, 2, 4, 7, 8, 10, 12, 21, 22, 23 y 25, contratos de serialización, release y protocolo.
- Se añadió el protocolo privado [`structural-indexing-fast-path.md`](../protocol/structural-indexing-fast-path.md) con generación, grupos, progreso, resultado, cancelación, estado y shutdown.
- `architecture/manifest.json` registra como propietarios separados `urdira-indexing-core`, `urdira-jsts-indexing-engine` y `urdira-indexing-worker`.
- El handoff y los findings quedaron como evidencia no normativa; la autoridad es la decisión aprobada, el protocolo y el manifest.

### 2.2 Workspace Rust

- `urdira-indexing-core`: trait cerrado `LanguageEngine`, validación de generaciones, grupos físicos, recibos idempotentes, UCE/canonicalización, IDs/digests, staging tipado `rusqlite`, publicación set-based, recuperación, cancelación, métricas, leases y reconciliación lexical.
- `urdira-indexing-worker`: worker persistente de composición, protocolo de proceso, scheduling de syntax/semantic, publicación, source commits, checkpoints WAL y mantenimiento secundario.
- `urdira-jsts-indexing-engine`: adaptador language-engine JS/TS.
- `urdira-jsts-syntax-worker`: worker Oxc con estado reutilizable e incremental.
- `urdira-jsts-native-projection`: proyección nativa de observaciones JS/TS.
- `urdira-worker-protocol`: framing y mensajes privados cerrados.
- `urdira-native-core`, `urdira-native-node` y `urdira-launcher`: bindings, loader y empaquetado nativo.

Los límites físicos de Rust son 64 owners, 4.096 filas o 16 MiB. El checker semántico usa grupos de hasta 32 owners y cursor propio para owners gigantes. Un owner grande continúa por páginas sin fusionar su identidad ni su recibo con otro owner.

### 2.3 Cutover de producción

- `apps/urdira/src/index.ts` falla cerrado si no existe el worker Rust; el writer TypeScript solo se conserva para oracle diferencial y pruebas.
- `workspace-indexing-session.ts` difiere los commits de fuente y devuelve al worker Rust la captura, en vez de materializar filas estructurales en V8.
- La generación de producción dejó de transportar manifestes completos de owners; Rust lee la frontera `source_artifacts`/`artifact_versions` desde su conexión arrendada.
- `CandidateIndexer` quedó como ruta de control/compatibilidad; el camino Rust no construye arrays de candidatos, transiciones, plantillas ni writer de publicación TypeScript.
- Fork, index-pack y source-only usan el mismo writer Rust cuando está configurado. Sus implementaciones TypeScript permanecen como oracle/compatibilidad.
- Se añadió exclusión por workspace para bootstrap, migración, GC, relocation, purge, fork, pack y mantenimiento lexical.

### 2.4 SQLite y SQL

- El esquema workspace-v3 y el SQL fijo de publicación se extrajeron a autoridades compartidas bajo `packages/storage/sql/`.
- Se generan wrappers TypeScript y constantes Rust desde esas autoridades y se comprueban sus digests.
- Rust inserta source observations, artifacts, versions, tombstones, candidate metadata, closures, dependencias, identidades, diagnósticos y proyecciones en staging tipado.
- La promoción usa `INSERT ... SELECT`/`UPDATE` set-based, assertions de `changes()`, swap atómico y visible-set digest.
- Cold e incremental comparten transacción; varían base, change set y owners afectados.
- La reconciliación lexical es post-publicación y usa writer Rust, lease común, `BEGIN IMMEDIATE`, busy timeout acotado y checkpoints WAL medidos.
- El retry lexical final quedó acotado a diez minutos con backoff limitado; no hay reintento infinito ni errores ignorados.

### 2.5 Duplicidades y optimizaciones probadas

Se eliminaron o redujeron manifestes duplicados TS/Rust, arrays de comandos y plantillas TypeScript, reconstrucción de filas lógicas en V8, callbacks por owner, serializaciones JSON repetidas, preparación semántica repetida (consume-once), lookups de identidad sin índice, digest de projections materializado en arrays, rebuild foreground de índices secundarios, diagnósticos de proyecto completo por ventana y clones profundos del bridge Rust/TS.

Se probaron y descartaron por no mejorar o romper invariantes: kernel Rust one-pass; transporte typed/columnar API v16; proyección de objetos completos por Node-API; ocho lanes semánticos; shortcut de llamadas directas/símbolos; explicit GC del checker; y cambiar WAL a `DELETE`.

## 3. Pruebas realizadas

### 3.1 Rust/native

```text
cargo fmt --all -- --check                         PASS
cargo test --workspace --locked                    PASS en las ejecuciones verdes
cargo clippy --workspace --all-targets --locked -- -D warnings  PASS
pnpm build:native                                  PASS
pnpm check:native                                  PASS
pnpm test:native                                   PASS
```

La ejecución Rust más reciente reportó, por crate, 16 tests de core, 13 de worker, 1 de JS/TS engine, 1 de projection, 19 de syntax worker y 3 de launcher, además de native-core/native-node/protocol y suites auxiliares sin fallos. Los recuentos 7/15 de core/worker que aparecen en notas antiguas son checkpoints históricos del mismo desarrollo.

### 3.2 Casos de corrección cubiertos

Se cubrieron grupos acotados y publicación atómica; digest/canonical length; owner gigante de 65 páginas; recibos separados syntax/semantic; identidad FactDelta; replay idempotente; staging tipado sin legacy JSON; reconciliación lexical; rollback de publicación; recibo conflictivo; cancelación; deadline expirado; CAS inválido; sidecar de cancelación; shutdown y limpieza de recibos; lease exclusivo; source commit/transición/tombstone/rollback; digests streaming equivalentes; rechazo de filas no canónicas; consume-once; filtrado JS/TS desde la frontera SQLite; y preservación del syntax lane con envelope semántico.

### 3.3 TypeScript e integración

- `pnpm typecheck`: PASS en los checkpoints finales.
- `pnpm check:architecture`: PASS; 16 paquetes revisados.
- `pnpm check:publication`: PASS en ejecuciones de 755, 783, 914, 930 y 946 archivos, según el estado del worktree.
- `git diff --check`: PASS.
- Suites focales de cutover/workspace/semantic/native: 14, 20, 26, 35, 62, 69, 100, 110 y 189 tests pasados en distintos checkpoints.
- Suite focal de sintaxis: 19/19.
- `tests/indexing-structural-preflight.test.ts` cubre la carrera `ENOENT` entre enumeración y `stat`, ignorándola solo cuando el archivo desaparece y propagando `EACCES`/otros errores.
- `tests/global-setup.ts` limpia raíces temporales abandonadas, excluyendo caches de modelos y agentes interactivos.

`pnpm verify` pasó en varios estados intermedios (por ejemplo, 1.933 tests, 90,00% de líneas, 100% de ramas críticas), pero no debe confundirse con el estado final posterior a todas las ediciones. La última ejecución larga disponible alcanzó 1.936 tests y 8 skips, pero quedó por debajo del gate de cobertura (89,96% frente al 90% requerido) tras un timeout previo en `tests/phase-worker-analysis-cache.test.ts`; la cualificación release final no está cerrada.

## 4. Medidas de rendimiento y resultados parciales

Son muestras únicas y no siempre usan el mismo build, harness o configuración.
No deben convertirse en P95 ni sumarse entre sí.

### 4.1 512 owners: serie de límites y transportes

| Variante | Wall | RSS pico | Reconciliación | Digest visible | Resultado |
| --- | ---: | ---: | ---: | --- | --- |
| Primer set-based | 68.310 s | 2,457 GiB | 0,0349% | `b0bca590...` | exacto, >45 s |
| API v14 typed | 68.959 s | 2,414 GiB | 0,0343% | `b0bca590...` | exacto, >45 s |
| Generic fast path | 66.476 s | 2,251 GiB | 0,0356% | `b0bca590...` | exacto, >45 s |
| Protocol 1.5 group drain | 68.363 s | 2,644 GiB | — | `b0bca590...` | exacto, >45 s |
| Protocol 1.6 typed transport | 69.751 s | 3,558 GiB | — | `b0bca590...` | descartado |
| Protocol 1.7 sealed rows | 67.333 s | 2,912 GiB | — | `b0bca590...` | exacto, >45 s |
| Group Rust preseal | 67.132 s | 2,738 GiB | 0,035% | `b0bca590...` | exacto, >45 s |
| One-pass Rust kernel | 69.319 s | 2,752 GiB | 0,0353% | `b0bca590...` | descartado |
| API v15 opaque receiver | 64.714 s | 2,648 GiB | 0,0373% | `b0bca590...` | exacto, >45 s |
| Consume-once | 66.114 s | 2,878 GiB | — | `b0bca590...` | exacto, >45 s |
| API v16 object projection | 66.199 s | — | — | `b0bca590...` | materialización V8 |
| API v16 opaque projection | 62.622 s | 2,657 GiB | — | `b0bca590...` | exacto, >45 s |
| Lightweight native seal | 64.063 s | 2,737 GiB | 0,0453% | `b0bca590...` | exacto, >45 s |

Después del short-circuit de la aplicación y de optimizaciones de índices/WAL se observaron muestras de 20,0--25,0 s para 512 owners, con RSS entre 1,70 y 2,00 GiB y digest exacto `sha256:40fb4b...`. Son cortes aprobados, no P95 ni evidencia de n8n completo.

### 4.2 Microgate SQLite de un millón de filas

| Variante | Transacción | Statements | Residual staging | Espacio temp/final |
| --- | ---: | ---: | ---: | ---: |
| Set-based inicial | 9.455 ms | 7 | 0 | 1,988x (falla ratio 1,5x) |
| Rust typed/generic | 5.678--5.782 ms | 7 | 0 | 1,000x |

El microgate demuestra que cambiar de motor SQLite no está justificado por el commit aislado; el problema de escala aparece en el pipeline completo, validación y rebuilds.

### 4.3 1.000 owners y cortes n8n

Resultados documentados, exactos respecto a su digest de corte:

- 36,737 s wall / 35,778 s readiness, RSS aproximado 2,44 GiB.
- 44,9 s wall / 43,6 s readiness.
- 45,944 s wall / 45,213 s readiness; checker 27,334 s y publicación 14,366 s.
- 43,615 s wall / 42,795 s readiness después del checkpoint WAL diferido.
- 41,420 s wall / 40,684 s readiness, RSS 2,522 GiB.
- 40,777 s wall / 40,041 s readiness, RSS 2,512 GiB.
- 39,068 s wall / 38,297 s readiness omitiendo índices temporales.
- 38,576 s wall / 37,845 s readiness con guard de export-query.
- 39,470 s wall / 38,646 s readiness tras compactar diagnostic keys.
- 38,842 s wall / 38,022 s readiness, RSS 2,197 GiB.
- 41,617 s harness / 40,967 s aplicación tras el source-frontier handoff.
- 41,809 s harness / 41,105 s aplicación en el cutover directo Rust.
- 44,282 s cold estructural y 12,318 s de una edición en otra replay.
- 32,115 s aplicación / 33,334 s harness con semantic lanes y digest streaming.
- 32,678 s aplicación / 33,327 s harness tras el índice `identity_assignments`.
- 29,092 s aplicación / 29,727 s harness con mantenimiento de índices secundarios asíncrono.
- 28,724 s aplicación / 29,332 s harness con seis lanes semánticos.

En una edición real, el mejor intervalo interno de publicación incremental bajó a aproximadamente 1,1--2,5 s; el harness completo llegó a 4,5--7,2 s por la ventana de estabilidad/watchers. Esto no califica el P95 incremental de 2 s ni representa ediciones con gran cierre de dependencias. Una creación de archivo llegó a 73,5 s porque fuerza reconstrucción del manifest del proyecto.

### 4.4 Ejecuciones completas de n8n

| Intento | Resultado |
| --- | --- |
| Primer cold directo Rust | `database or disk is full` durante semantic; sin digest |
| Reintento 120 s | timeout, `EPIPE`, sin snapshot final |
| Reintento 600 s con lock lexical | 3.183.253 filas estructurales; `database is locked`; sin JSON final |
| Tras connection handoff, 600 s | publicación Rust `469.634 ms`, app `structural_ready_ms=950.825`; shutdown antes de digest |
| Ventana 30 min | cold `1.318.331 ms`, digest `cdcf2468...`; mutación `166.771 ms`, digest `ba617239...`; correcto pero muy fuera de objetivo |

El último run completo confirma que la ruta puede terminar y producir salida exacta, pero también confirma la regresión práctica: la finalización completa queda muy por encima de diez minutos. No existe una medición comparable y conservada del antiguo writer TypeScript para cuantificar el delta exacto; sí hay evidencia suficiente para afirmar que el objetivo actual no está conseguido.

### 4.5 Smoke de locks y lexical

Con 64 owners y una mutación, tras el handoff de conexión:

- cold: 4,334--4,965 ms;
- incremental: 937--1.063 ms;
- `wal_busy=0`;
- todos los frames WAL checkpointed;
- sin `SQLITE_BUSY`/`SQLITE_LOCKED` en ese smoke.

Esto valida el orden de liberación de la conexión, pero no extrapola la seguridad de locks al corpus completo.

## 5. Limpieza y artefactos

Las campañas interrumpidas habían generado 18.739 directorios y 1.078 archivos temporales en el TMPDIR de macOS. Se eliminaron únicamente raíces temporales abandonadas (`urdira-n8n-incremental-*`, `urdira-native-preflight-*`, `urdira-jsts-worker-test-*` y reports de `/tmp`), liberando aproximadamente 214--217 GiB. Se conservaron caches de modelos, agentes interactivos, source y artefactos nativos.

El worktree actual muestra también borrados (`D`) bajo `release/benchmarks/` de scripts y resultados históricos. Los JSON citados en los documentos no están todos presentes ahora; sus valores y checksums quedaron transcritos en los dos documentos de evidencia existentes. No se debe repetir una campaña solo para reconstruir un JSON perdido sin decidir antes qué artefactos históricos restaurar desde Git.

## 6. Qué no repetir

1. No repetir variantes de transporte por owner, preseal, one-pass JSON, projection objects, consume-once o digest streaming: ya fueron comparadas y no eliminaron el span dominante.
2. No repetir 512/1.000 owner como sustituto del corpus completo: ya hay múltiples muestras exactas y la variación está documentada.
3. No cambiar SQLite por `rusqlite` u otro writer: el microgate de un millón de filas pasa en 5,7--9,5 s.
4. No activar el writer TypeScript en producción: está aislado como oracle y el worker Rust es la única ruta productiva.
5. No lanzar la campaña 20 cold/60 incremental: nunca quedó cualificada y requería autorización explícita.
6. No interpretar RSS >2 GiB como rechazo automático si tiempo y digest son válidos: la enmienda acordada lo hace advisory; OOM, digest, espacio temporal, lock o tiempo siguen siendo fallos.
7. No usar resultados de 512/1.000 como prueba de cold n8n completo.

## 7. Estado abierto

- Cold n8n completo: **no cumple** ≤30 s ni ≤45 s; la última ejecución correcta tardó 21 min 58 s.
- Incremental n8n completo/P95: **no cualificado**; una mutación amplia puede tardar minutos.
- P95/P99, RSS y ratio de temporales del corpus completo: **sin cualificar**.
- Lock safety concurrente en corpus completo: **sin cualificar**; solo smoke de 64 owners validado.
- `pnpm verify` final tras todo el worktree: **no debe declararse verde**; la última evidencia queda por debajo del gate de cobertura, aunque hubo checkpoints intermedios verdes.
- Release acceptance/packaging final: **no aprobado**.

## 8. Referencias primarias

- [`2026-08-29-indexing-performance-findings.md`](2026-08-29-indexing-performance-findings.md): cronología completa de hipótesis, mediciones, descartes y breakdowns.
- [`2026-08-29-rust-core-indexing-handoff.md`](2026-08-29-rust-core-indexing-handoff.md): arquitectura, gates, contratos, ownership y evidencia de corrección/locks.
- [`structural-indexing-fast-path.md`](../protocol/structural-indexing-fast-path.md): protocolo privado vigente.
- [`architecture/manifest.json`](../../architecture/manifest.json): límites y propietarios de paquetes.
- [`packages/storage/sql/`](../../packages/storage/sql/): autoridades SQL y generados.

Este documento es un índice consolidado de la sesión. Las cifras históricas que difieren pertenecen a builds, límites, harnesses y experimentos distintos. Para una nueva campaña debe conservarse el corpus, runtime nativo, configuración de lanes, digest de autoridad y ventana de readiness exactos antes de comparar tiempos.
