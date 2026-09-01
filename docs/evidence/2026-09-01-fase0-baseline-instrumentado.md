# Fase 0: baseline instrumentado del cold completo de n8n (2026-09-01)

**Harness:** `pnpm preflight:n8n-incremental` — corpus n8n retenido (digest `sha256:1dd28be4...`), 14.083 owners solicitados / 14.082 JS/TS, cold + 1 mutación, `URDIRA_DEBUG_TIMING=1` + `URDIRA_STORAGE_DEBUG_TIMING=1`, ventana de readiness 7.200 s. Artefactos nativos del 2026-08-31 (posteriores a todo `.rs`), `apps/urdira/dist` al día. Log y JSON: `n8n-full-fase0.{log,json}` (scratchpad de sesión; cifras transcritas íntegras aquí).

**Digests exactos:** cold `sha256:cdcf2468...` (idéntico al run histórico de 30 min), mutación `sha256:ba617239...` (ídem). Exit 0, sin EPIPE/ENOSPC/disk-full.

## Cold: 946,8 s total (structural_ready 944,6 s) — conciliación EXACTA

| Fase (app `scan timings`) | s | % |
|---|---:|---:|
| enumerate | 7,5 | 0,8 |
| source_catalog (source_ready 68,2) | 60,7 | 6,4 |
| stage_plan | 1,2 | 0,1 |
| plugin_analyze | 453,4 | 48,0 |
| publish | 421,8 | 44,7 |
| **Total structural_ready** | **944,6** | 100 |

Harness: runtime_load 0,8 + daemon_start 0,1 + workspace_add 1,4 + readiness 944,5 + digest 0,006 = 946,8 s. Nota: `cold_elapsed_ms=1395877` del JSON incluye la mutación (bug de contabilidad del script, el reloj no se detiene); cold real = `total_duration_ms` de cold_phase_timings = 946,8 s.

### plugin_analyze 453,4 s (concilia exacto)

| Sub-span (worker Rust) | s |
|---|---:|
| jsts syntax analysis (14.082 owners) | 0,78 |
| jsts facts extraction (230 grupos, serial) | 84,6 |
| semantic closure lane=primary | 2,0 |
| semantic closure lane=extra ×5 (concurrentes, ~12 s wall) | ~12 |
| jsts semantic generation (952 grupos, 6 lanes) | **367,5** |

### publish 421,8 s (`rust core publish ms=421012`; zonas = 356,9 s)

| Zona (deltas; `debug_publish_phase` es ACUMULADO desde publish_started, main.rs:4746) | s |
|---|---:|
| source_transitions + control_plane | 0,0 |
| **record_and_identity_promotion** | **236,8** |
| dependency_promotion | 36,2 |
| visible_record_digest | 55,6 |
| projection_set_digest | 0,07 |
| cold_index_rebuild | 28,3 |
| snapshot_and_current_state | 0,0 |
| **Fuera de zonas** (antes de source_transitions o tras snapshot: begin/commit/checkpoint/staging) | **~64,9** |

## Mutación (content-00, 1 archivo): 449,1 s — el cómputo real son ~10 s

- mutation_apply 0,01 s; readiness **449,1 s**.
- Scan exitoso: total 163,9 s = enumerate 7,1 + **source_catalog 54,2** + stage_plan 0,6 + plugin_analyze 2,8 + **publish 98,6** (zonas: solo 4,2 s → **~94,4 s de espera dentro del publish**, presumiblemente BEGIN IMMEDIATE contra el writer lease del mantenimiento lexical + checkpoint).
- Los ~285 s restantes: un scan FALLÓ con `EEXIST` sobre `.sqlite.urdira-writer.lock` (mantenimiento lexical post-cold reteniendo el writer) y el retry esperó a que terminara.
- Mantenimiento lexical post-cold: `lexical reconcile complete ... wal_frames=2.560.409 checkpointed=2.560.409` (~10,2 GiB de tráfico WAL) + `secondary indexes ready ... frames=899.997` (~3,6 GiB). Esto es lo que retiene el lock durante minutos.

## Otras medidas

- `readiness_poll db_section_ms_total=297165 count=9700 avg_ms=30.6` — cada poll de status cuesta ~31 ms de DB.
- RSS: `/usr/bin/time -l` del proceso controlador: max RSS 2,62 GB, peak footprint 2,0 GB. **No cubre el árbol completo** (lanes Node/tsgo son procesos hermanos gestionados por Rust) — el RSS por lane sigue sin muestra autoritativa.
- Fallos: 1 único scan fallido (EEXIST, recuperado). Sin `database is locked`, sin disk-full.

## Consecuencias para las fases (ranking actualizado de palancas)

**Cold (946,8 s):**
1. Semantic generation 367,5 s → F3a (lanes contiguos) + F3b (régimen RSS >1.200 roots) + F5 híbrido.
2. record_and_identity_promotion 236,8 s → F1a (drop/recreate índices) + F1b (ORDER BY).
3. Facts extraction 84,6 s → F4 (pipeline de threads).
4. Fuera-de-zonas del publish ~64,9 s → instrumentar (añadir zonas begin/commit/checkpoint) en F1.
5. source_catalog 60,7 s → nueva palanca (no estaba en el plan; también impuesto fijo incremental).
6. visible_record_digest 55,6 s → F1d (55,6 s, justo bajo el umbral de 60 s — segunda ronda).
7. dependency_promotion 36,2 s + cold_index_rebuild 28,3 s → F1a los cubre.

**Incremental (449,1 s, cómputo real ~10 s):**
1. Contención del writer lock por mantenimiento lexical (~285 s de espera + ~94 s dentro del publish) → F2 (el retry EEXIST debería coexistir o el lexical ceder el lease en tramos).
2. source_catalog 54,2 s fijo por scan → misma palanca que #5 de cold.

**Descartes confirmados por medición:** el closure×6 NO es problema (~14 s wall); el "fantasma de 367 s" del run histórico es el mantenimiento lexical/checkpoint post-ready (este harness lo saca del cold y lo paga la mutación).

## Anatomía de source_catalog (exploración 2026-09-01, código)

El impuesto fijo de ~54-60 s/scan tiene tres causas en `packages/engine/src/source-indexer.ts` + `packages/engine/src/directory-provider.ts`:
1. `observations.push` ocurre ANTES del corto-circuito `equivalent` (source-indexer.ts:783-789) → los 14.235 archivos atraviesan readAll/assemble/digest-verify en cada scan aunque solo cambie 1.
2. La identidad de metadatos incluye `ctime_ms`/`inode`/`device` (directory-provider.ts:422-431): cualquier `git checkout`/`npm install`/guardado atómico invalida el árbol entero y re-escribe todo el CAS (en el cold de hoy: `source_deferred_version_count=14235`).
3. El provider nunca recibe la frontera previa: no hay comparación stat-first que evite `#digestFile` (directory-provider.ts:1023). El hash del corpus vive en `enumerate`.
4. Punto ciego: la escritura CAS (`prepareSourceIndexContent`, storage.ts:959-989, con fsync de archivo+directorio por blob) no tiene `timed()` — instrumentación añadida 2026-09-01 antes de tocar comportamiento.

**Atribución medida (run F1, 2026-09-01):** cold 54,5 s = batch_wait 7,2 + digest_verify 6,9 + provider_read 5,1 + cas_write 6,4 (14.235 blobs / 82,7 MB) + 33,3 sin atribuir. Incremental 62,5 s = provider_read 40,8 (lee TODOS los archivos; 14.234/14.235 equivalentes, 1 blob escrito) + verify 6,7 + batch_wait 6,8 + ~46 sin atribuir (solape con generator). Confirma stat-first + filtrado de equivalentes como palanca.

Palancas en orden (pendientes de atribución medida): filtrar equivalentes antes de readAll/observations; stat-first con frontera previa; identidad de metadatos sin ctime/inode (OJO: cambia `analysis_metadata_digest` → re-versión única tipo upgrade, decisión con dueño); solapar batches (bucle serial source-indexer.ts:504); doble digest de batch productor/consumidor.
