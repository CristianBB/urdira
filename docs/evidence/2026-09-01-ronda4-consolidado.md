# Ronda 4 consolidada (F4 facts pipeline + dieta source_catalog) — 2026-09-01

Run r4b completo, exit 0, **digests EXACTOS contra la nueva autoridad** (cold `sha256:f818096cbc907a36851bd...`, mutación `sha256:8551f5b069ebc...`). Sin EPIPEs, sin receipt conflicts, sin scan failures.

## Evolución de la sesión completa (cold n8n, 14.082 owners)

| Métrica | Baseline F0 | Ronda 3 | Ronda 4 (r4b) |
|---|---:|---:|---:|
| Cold structural/total | 944,6 / 946,8 s | ~748 / 750,8 s | ~778 / 781,5 s (ruido I/O) |
| semantic generation | 367,5 | 244,7 | 254,1 |
| facts extraction | 84,6 | 73,3 | 68,9 (pipeline paralelo) |
| publish total | 421,8 | 368,7 | 387,6 |
| **Mutación total** | **449,1** | 130,0 | **130,0** |
| — scan real de la mutación | 163,9 | ~35 | **~35** (source_catalog 54→10 s, enumerate 7 s→5 ms, publish 17,3) |

## Incidencia F4 (resuelta)

El pipeline de facts descartaba los recibos aceptados en el bucle de backpressure → `group_count` colapsaba (log `groups=6` vs 230) → el lane semántico numeraba grupos desde 6 chocando con secuencias commiteadas → `conflicting physical group receipt` determinista a escala (3/3), con cascada de ~10 EPIPEs secundarios por run. Fix: acumular los recibos del drain (main.rs ~2056) + 2 tests de regresión que reproducían el fallo pre-fix (80 grupos saturando la ventana de 6; owner gigante de 40 páginas). Los cortes de 2.000 owners NO detectan este régimen (no llenan la ventana de backpressure) — el run completo sigue siendo obligatorio por ronda.

## Dieta source_catalog (shipped)

- Equivalentes ya no pasan por readStream/CAS (comprobación por hashes previa a la lectura); las filas de observación se mantienen (cero riesgo de contrato; verificado que derive_source_transitions solo lee versions/tombstones).
- Pipeline de batches profundidad 2 (CAS del batch N solapa con parse/verify/read del N+1); orden de commits intacto.
- Bucket `source_batch_parse` nuevo; incremental: todos los buckets ~0-1 ms.

## Ronda 5 (dieta staging TEMP) — r5, digests EXACTOS

| Métrica | r4b | r5 (dieta TEMP) |
|---|---:|---:|
| **Cold structural** | ~778 s | **~573-576 s (−39% vs baseline 944,6)** |
| record_and_identity_promotion | ~190 | **117,0** |
| dependency_promotion | ~31 | 9,5 |
| publish total | 387,6 | **260,2** |
| semantic generation | 254,1 | **185,6** (bonus: staging ligero acelera accepts del lane semántico) |
| facts extraction | 68,9 | 61,3 |
| commit + checkpoint | ~90 | ~86 (sin cambio — palanca WAL-less pendiente de decisión) |
| Mutación | 130,0 | **274,8 (REGRESIÓN, en fix)** |

Dieta shipped: canonical_text/publication_json eliminadas, operation_id/candidate_generation_id des-materializadas (conexión fresca por generación hace el filtro redundante), 6 columnas digest/id hex(71B)→BLOB(32B) con reconstrucción `'prefix'||lower(hex())` en promoción (bytes idénticos, digest parity verificada).

**Regresión incremental: RESUELTA.** Causa real: la subconsulta correlacionada de `DIRECT_PUBLICATION_CLOSURES_SQL` envolvía la columna del STAGING en `'record:'||lower(hex(...))`, perdiendo su índice covering `(lane, publication_record_id)` → escaneo lineal del staging por cada fila externa (¡900x medido!). El cold no lo sufría (0 filas externas en primer publish) y el gate de 2.000 tampoco (volumen pequeño). Fix: `unhex(substr(r.record_id,8))` en el lado durable (una evaluación por fila externa), seek de 2 columnas restaurado + test EXPLAIN QUERY PLAN que falla pre-fix (asserta SEARCH y nunca SCAN).

**Run r6 de confirmación (digests EXACTOS):** cold **559,7 s** (−41% vs baseline), publish 255,2 s, semantic 175,1 s, mutación **142,6 s** con publish incremental 18,3 s y scan real ~36 s.

Nota positiva en cadena: `lexical reconcile ... wal_frames=2` (baseline: 2.560.409) — el checkpoint del cold deja el WAL vacío para el mantenimiento.

## Cola pendiente (por ganancia estimada)

1. **F5 híbrido** (diseño en curso): ~90% de los 250 s de semantic es walk JS (medido: 1,35M requests IPC = 147 s repartidos en 6 lanes ≈ 25 s wall; serverTime Go 95 s ≈ 16 s wall). Estimación semantic → 30-60 s.
2. **Dieta staging TEMP** (explorada, plan concreto): `canonical_text`/`publication_json` YA son NULL en cold — el peso real: digests hex-texto ~1,35 GiB → BLOB 32 B (reconstrucción `'sha256:'||lower(hex(...))` en promoción, bytes idénticos), ids constantes por fila ~220 MiB, owner-ids ~450 MiB. Ataca facts-accept + commit + checkpoint.
3. Cold DB sin WAL + rename atómico (−60/−100 s, decisión dueño pendiente).
4. Cola de mutación restante (~95 s de espera lexical/estabilización tras el scan de ~35 s).
5. Menor: silenciar EPIPEs secundarios cuando hay error primario registrado.
