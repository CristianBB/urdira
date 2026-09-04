# Resumen ejecutivo de la campaña v4 (cierre 2026-09-05)

Resumen no normativo. Cada cifra remite a su documento de evidencia; la
autoridad normativa sigue en las decisiones 26-29
(`docs/decisions/26-v4-structural-store.md` … `29-v4-rust-owned-scan-pipeline.md`).

## Objetivo

El 2026-09-02 el dueño exigió que el escaneo en frío de un repositorio
quedara "indexado y consultable en pocos segundos" y que la publicación
incremental (edición, creación, borrado, renombrado) fuera durable en menos
de un segundo, de forma destructiva y sin migración desde v3. Una
optimización de digests ya en curso solo ahorraba ~2,8 s de una edición de
9,9 s, así que el dueño autorizó mover todo el pipeline de indexación a
Rust y sustituir las tablas SQLite estructurales de v3 por un almacén
propio.

## Qué se construyó (arquitectura, en 10 líneas)

1. Un proceso Rust persistente por workspace posee el escaneo completo
   (catálogo, parseo, semántica, materialización, escritura, snapshot) tras
   un único comando de protocolo (`WorkspaceScan`), en vez del protocolo
   multi-mensaje orquestado desde TypeScript de v3.
2. El corpus estructural vive en un almacén inmutable, por generación,
   servido por mmap (`crates/urdira-structural-store`) — SQLite queda solo
   para catálogo, snapshots, control-plane, léxico y vectores.
3. Los digests Merkle usan un árbol "bucketed" de profundidad fija (5
   nibbles, 1.048.576 buckets) en vez del árbol radix de v3, que era
   inviable a escala de millones de registros.
4. La semántica combina el léxico E1-E3 ya existente con "typeflow"
   (resolución de tipos declarados, en Rust, sin invocar el compilador),
   corriendo sin bandera en v4 desde el 2026-09-04.
5. Todo sitio de llamada o herencia que ninguna de las dos vías anteriores
   resuelve se publica como fila "possible" con un diagnóstico razonado, en
   vez de desaparecer silenciosamente (como hacía la primera versión de v4).
6. Un paso residual en segundo plano invoca el compilador real (`tsgo`)
   fuera del camino crítico, vía un cliente JSON-RPC escrito desde cero en
   Rust, y publica una generación de mejora aparte.
7. v4 es desde el 2026-09-04 el formato por defecto para workspaces nuevos
   (`URDIRA_V4` distinto de `"0"`); v3 sigue compilándose y sirviendo los
   workspaces existentes sin cambios.
8. El camino incremental mantiene índices inversos propios (candidatos de
   resolución de import, cierre de superficie exportada) en vez de
   recalcular el corpus completo en cada mutación.
9. Cada generación delta es un único fichero contenedor con un solo fsync,
   en vez de hasta 18 ficheros con un fsync cada uno.
10. Fork y empaquetado (index-pack) de un workspace v4 son una simple copia
    de ficheros más una reescritura de identidad, porque la identidad de
    cada registro depende solo de su contenido — sin el remapeo
    registro-a-registro que exige v3.

## Antes / después

| Métrica | Antes (v3 / plan) | v4 (2026-09-05) | Evidencia |
|---|---:|---:|---|
| Escaneo en frío, n8n (14.082 owners) | ~560 s | **27,7 s** (mediana; 27,3-29,4 s) | final §4.1 |
| Edición incremental (worker) | ~5-6 s | **0,45-0,58 s** | final §4.3 |
| Edición incremental (daemon, p50 / p95) | no medido | **1,33 s / 3,75 s** | final §4.4 |
| Crear / borrar / renombrar (worker) | ~6-7 s | **~0,45-0,55 s** | final §4.3 |
| Detección real del watcher (kqueue) | hipótesis: 2-3 s | **7,7 ms p50 / 45,3 ms p95** (el "watcher lento" era un bug del arnés de medición, no del sistema) | P3-7 §4 |
| Paridad de llamadas confirmadas vs v3 | — | **54,78 %** (112.565 / 205.468) | P1-D-h, final §2.6 |
| RSS pico en frío | — | **6,86 GB** mediana (objetivo ≤ 3 GiB) | final §4.1 |
| Verificar / fork / pack | no existían para v4 | implementados y probados en fixture; **no ejercitados** en la sesión final de medición | decisión 26 |

## Objetivos (gates) cumplidos y no cumplidos

**Cumplidos:** determinismo de las raíces Merkle en más de 30 escaneos
independientes; las cinco clases de mutación incremental worker-only
(edición, crear, borrar, renombrar, hub-edit sin cambio de superficie) por
debajo de 1 s; la latencia real de detección del watcher kqueue (muy por
debajo de su objetivo).

**No cumplidos:** los cinco objetivos numéricos del escaneo en frío
(catálogo ≤ 1,5 s, materialize ≤ 4 s, `Queryable` ≤ 8 s, `ScanCompleted`
≤ 12 s, RSS ≤ 3 GiB — el más cercano queda a 2,3-2,7×); la publicación
durable observada por el daemon (< 1 s objetivo, 1,33 s real; el watcher
queda descartado, y el resto del hueco — 1,4-1,7 s de worker visto a
través del daemon frente a 0,45-0,6 s en proceso — tiene dos causas
candidatas sin aislar: coste real del límite de proceso/IPC, o el hash de
todo el corpus que el arnés hace tras cada mutación, P3-5 §5.3); la
paridad de llamadas ≥ 90 % (54,78 % real).

| Gate | Objetivo | Medido (final §4.1/§4.3/§4.4; P3-7 §4; P3-8a §2.4) | Estado |
|---|---:|---:|---|
| Catálogo | ≤ 1,5 s | 5,0-5,6 s | no |
| Materialize | ≤ 4 s | 8,4-11,4 s | no |
| `Queryable` en frío | ≤ 8 s | 27,3-30,0 s | no (3,4-3,7×) |
| `ScanCompleted` en frío | ≤ 12 s | 29,6-32,3 s | no (2,5-2,7×) |
| RSS | ≤ 3 GiB | 6,56 / 6,86 / 8,16 GB | no |
| Determinismo / independencia de hilos | raíces idénticas | idénticas en 3/3 runs finales y en todas las rondas | sí |
| Incremental solo worker: edición p50 | ≤ 0,5 s | 0,45-0,58 s | sí |
| Incremental solo worker: crear / borrar / renombrar | ≤ 1 s | 0,50 / 0,45 / 0,51 s | sí |
| Hub-edit superficie sin cambio / con cambio (841 owners) | ≤ 1 s / proporcional | 0,47 s / 1,43 s | sí / sí (proporcional; > 1 s absoluto) |
| Edición durable vista desde el daemon | < 1 s (p50 ≤ 0,7 s) | p50 1,33 s consultable, 1,40 s durable; p95 3,75 s / 22,8 s | no |
| Typeflow por edición estable | ≤ 40 ms | < 0,5 ms | sí |
| Detección del watcher (kqueue) | p50 ≤ 50 ms / p95 ≤ 150 ms | 7,7 / 45,3 ms | sí |
| Paridad de llamadas: mantener ≥ 112.565 y 0 destinos distintos | — | 112.565 / 0 / 0 faltantes | sí |
| Paridad de llamadas: ≥ 90 % (P1-D-f) / ≥ 120.000 (P1-D-g) | — | 54,78 % / 112.565 | no |

## Elementos abiertos, por severidad

1. **CRÍTICO — corrupción no determinista de `identity_key`** (P2-2m):
   ~1 de cada 1,4 millones de registros pierde su clave de identidad (queda
   a cero) de forma silenciosa; el `record_digest` no se ve afectado. Causa
   no confirmada; el sospechoso principal es la bisección paralela
   (`rayon::join`) del kernel de materialización. Solo el invariante de
   consistencia de clasificación y un escaneo diagnóstico dedicado lo
   detectan.
2. **`rpc_error` sin resolver**: 13.737 sitios (105.635 en bruto) fallan
   una llamada al compilador real con un error de "handle obsoleto"
   persistente, concentrado en ficheros `.test.ts` con `vi.mock`/
   `vi.hoisted` intensivo. Tres reproducciones sintéticas fallaron; un
   intento de arreglo (descender al identificador de un callee de acceso a
   propiedad) causó una regresión real y fue revertido.
3. **Bug de arnés `spawn EBADF`**: el paso final de verificación por
   oráculo del arnés de medición (`scripts/v4-mutation-harness.mjs`) falla
   de forma reproducible al lanzar el subproceso de comparación; no bloquea
   la corrección del pipeline (verificada por otra vía), pero deja sin
   cubrir esa comprobación automática concreta.
4. **Uniones y sobrecargas sin canal de "possible"**: `typeflow` no tiene
   hoy representación de tipos unión, así que no puede emitir una fila
   "possible" por candidato para una llamada ambigua por sobrecarga o
   unión — es una funcionalidad nueva, no cableado pendiente.
5. **Migración de workspaces v3 existentes** a v4 no está abordada; solo
   los workspaces nuevos adoptan v4 por defecto.

## Decisiones pendientes del dueño (se presentan, no se deciden aquí)

**a) Volumen de registros de diagnóstico.** Para igualar la cobertura de
sitios de llamada de v3, v4 añadió 637.530 filas "possible" más 637.531
diagnósticos `jsts:unresolved_call` — un +82 % sobre el corpus sin ellos
(1.554.292 → 2.831.264 registros), la mitad de todo lo que el pipeline
materializa hoy. Esta cifra es necesaria para lo que el paso residual
mejora, pero el contenido de cada diagnóstico es recuperable de la
identidad de su fila "possible" emparejada. ¿Deben estos diagnósticos
seguir existiendo como registros Merkle de primera clase, con su propio
coste de materialización y escritura, o representarse de forma más barata?

**b) Eliminación destructiva de las rutas de código de v3.** Nada de la
maquinaria de v3 se ha borrado: los comandos de protocolo v3
(`IndexGeneration`, `AcceptGroup`, `AnalyzeSemanticGroup`, `InvokeSemantic`,
`FinalizeGeneration`, `SourceIndexCommit`/`Rollback`), la ruta SQL completa
de publicación de candidatos (`candidate_publication_*` y el staging que la
alimenta), los escritores `MerkleRadixSet`, el conversor `NativeStoreBuilder`,
y el lane semántico del worker Node siguen compilándose y sirviendo cada
workspace v3 existente. Esto es intencional (decisión 22: el corte v3→v4
es un trabajo de fase 4 aparte), pero implica mantener dos pipelines
completos en paralelo indefinidamente hasta que se decida cuándo y cómo
ejecutar ese corte.

**c) ¿Seguir invirtiendo en el objetivo de escaneo en frío?** Las rondas de
optimización del kernel dejaron palancas identificadas y no aplicadas, con
su ganancia estimada:
- **Volumen de registros** (arriba): sin las filas "possible"/diagnóstico,
  el corpus baja un 45 % y el escaneo en frío ahorra ~1,7-2,4 s de
  materialización y ~1,1-1,8 s de escritura.
- **Ancho de banda de escritura**: el hash `xxh3` por fichero corre a solo
  300-455 MB/s en el pipeline real, frente a 4,85-9,2 GB/s medidos para el
  mismo código de forma aislada — atribuido a contención de memoria entre
  cinco tareas paralelas, no a un defecto algorítmico. La palanca
  identificada (escribir directamente a un `MmapMut` compartido) ahorraría
  ~1-2 s pero exige código `unsafe` sobre rangos disjuntos de memoria, no
  auditado.
- **RSS en streaming**: existe una tensión arquitectónica real entre asignar
  ordinales de diccionario por clave ordenada (necesita ver todo el
  conjunto de owners antes de fijar ningún ordinal) y liberar la memoria de
  cada owner en cuanto se procesa (que exigiría reprocesar el corpus dos
  veces, o volver al orden de aparición que bloquea el paralelismo actual).

Ninguna palanca por sí sola cierra el objetivo (el escaneo en frío queda
hoy en 27,7 s frente a un objetivo de 8-12 s); combinadas, no hay una
estimación conjunta medida.

### Anexo a (b): qué se borraría y qué depende de ello

Se borrarían los comandos v3 del protocolo y su transporte multi-mensaje,
el escritor de publicación de candidatos con sus ~20 tablas
`candidate_*`/`record_occurrences`/`graph_edges`, `MerkleRadixSet` y los
escritores de digest de la decisión 22, `NativeStoreBuilder` con
`text_sidecar.json`, el lane del checker en el worker semántico Node
(`analyzer.ts`), fork/pack por remapeo (decisiones 12/23) y la readiness por
fragmentos v3 del daemon. Dependen de ello hoy: cada workspace v3 existente
(sin migración: se reindexa desde cero); la suite de tests v3, que
`vitest.config.ts` fija con `URDIRA_V4=0` como base (P4-b-2); la BD v3
retenida que `scripts/v4-call-parity-diff.mjs` abre como verdad de paridad;
y las comparaciones de benchmark v3↔v4. Precondiciones razonables antes de
borrar: cerrar P2-2m, decidir (a), y fijar las raíces autoritativas
actuales, que tras P1-D-h no están impresas en ningún documento (decisión
27).

### Anexo a (c): estimación conjunta

Sumando de forma optimista las palancas anteriores más las dos menores
identificadas en el kernel (cola de rayon en el owner más grande,
`max_task_ms` 280-527 ms frente a una media de 2,5-3,8 ms, p2-2b §18.1; un
validador byte a byte de facetas en lugar de JSON genérico, ~13 % de las
muestras del pase 1, §17.5) y el catálogo (clave primaria sustituta o
inserciones preordenadas en SQLite, `sql_exec` 2,0-2,9 s es coste de
B-tree y no de despacho, §15.3), el frío quedaría en torno a 20 s: todavía
1,7× sobre `ScanCompleted` ≤ 12 s y 2,5× sobre `Queryable` ≤ 8 s. El suelo
criptográfico (`sha256::compress256`, ~4 % del pase 1) no se mueve sin
cambiar el contrato de digest. Alternativas: aceptar ~28 s como el número
de v4 y cerrar la campaña de frío, o redefinir el gate de `Queryable` con un
callback real a mitad de escritura (hoy `write_base` es síncrono y
`Queryable` llega ~2,3 s antes que `ScanCompleted`).

## Inconsistencias entre documentos de evidencia (listadas, no resueltas)

- `external` 41.001 (contador de la pasada residual) frente a
  `external_lib` 40.812 (diff de paridad): poblaciones distintas; ningún
  documento hace la cuenta.
- `confirmed_row_build_failed`: 12.743 en P1-D-d frente a 15.590
  atribuidos a P1-D-d por P1-D-f/g.
- `rpc_error` en bruto: 101.861 (P1-D-e final), 101.870 (punto de partida
  de P1-D-f), 105.417 (P1-D-f final), 105.635 (final §3.2).
- Llamadas confirmadas en frío: 96.373 (P2-2e) frente a 96.847 (P2-2i);
  474 de deriva sin explicar.
- Frío vía daemon: 22.352 ms (P3-1), 26.481 ms (P3-2), 22.238 ms (P3-5),
  24.484 ms (P3-7); cada sesión lo atribuye a ruido, sin causa común.
- `ScanCompleted` sube de 18,3-19,9 s (p2-2b §14) a 22,1-24,8 s (§15.0,
  re-baseline con el mismo número de registros) sin explicación.
- Regresión de `resolve_ms` en DELETE 71 → 331 ms (P3-6) no reproducible
  después (64-66 ms, §15.7).
- P3-4 describe cualquier segundo escaneo como imposible (generación fija a
  1) mientras P3-1/P3-2 miden generaciones múltiples; no consta cuándo se
  cerró.
- El bloqueo de renombrado por coalescencia del watcher (P3-1 §11) nunca se
  declara cerrado; P3-7 renombra con éxito y P3-8a arregla un bug distinto,
  del arnés.
- Las raíces autoritativas tras la reparación de clasificación (P1-D-h) no
  están impresas, aunque se declaran idénticas entre los 3 runs.
- `records.tree` cambió de `cba95efc…` a `a281d6a5…` con recuentos
  idénticos y sin causa localizada (records-root-change.md).
- `check:native` falló por fmt/clippy en `semantic_sites.rs` (P4-b-2 §4)
  mientras la sesión final reporta `clippy -D warnings` limpio en todo el
  workspace (final §5).
- Este mismo resumen fue escrito dos veces el 2026-09-05 por dos sesiones
  concurrentes; la versión actual conserva la estructura de la segunda y
  añade la tabla de gates, los anexos y esta lista de la primera.
