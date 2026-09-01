# Ronda 2 (F1-r2 + F3a lanes contiguos + F3b RSS + F2 lexical) — run parcial 2026-09-01

Run cold completo VÁLIDO como evidencia de tiempos; la mutación FALLÓ (ver abajo) y el JSON final no se escribió → **digest del cold de esta ronda SIN verificar** (el data root temporal no sobrevivió). El próximo run tras F2-r2 debe verificar paridad.

## Cold (de los logs; structural_ready ≈ 776 s vs 944,6 baseline → −18%)

| Fase | Baseline | F1 | Ronda 2 |
|---|---:|---:|---:|
| **semantic generation** | 367,5 | 364,9 | **249,3 (−32%)** ← F3a+F3b |
| facts extraction | 84,6 | 74,7-78,7 | 73,3 |
| plugin_analyze total | 453,4 | 444,9 | **323,7** |
| record_and_identity_promotion | 236,8 | 200,8 | **189,4** |
| dependency_promotion | 36,2 | 30,3 | 30,9 |
| visible_record_digest (zona) | 55,6 | 82,7 | **20,0** (18,2 índice inline + ~1,8 scan) ← F1-r2 |
| cold_index_rebuild | 28,3 | 27,3 | 25,6 |
| commit | (gap) | 28,4 | 40,1 |
| checkpoint TRUNCATE | 0 | 49,4 | 54,2 (frames=0 — anomalía abierta) |
| publish total | 421,8 | 449,7 | **391,9** |
| source_catalog | 60,7 | 54,5 | 52,6 |

## Mutación: FALLÓ — nuevo modo de fallo destapado

El EEXIST de Node ya no ocurre (F2-T3 funcionó), pero el commit de fuentes del lado RUST no espera el lease: `core:source_index_commit_failed: workspace structural writer is already active` al perder la carrera contra un tramo del lexical troceado. El código específico se pierde (llega sin `code` → `core:workspace_scan_failed` genérico), no entra al camino retryable, `last_scan_error` queda fijado y el harness lo declara terminal. **Fix en curso (F2-r2)**: espera acotada con backoff en la adquisición Rust del camino de scan + propagación del código busy.

## Anomalía del checkpoint: RESUELTA (lectura de código, 2026-09-01)

`cold_checkpoint_ms≈50s frames=0`: el `wal_autocheckpoint` por defecto backfillea el WAL entero durante el COMMIT (de ahí `commit_ms`=28-40 s); el TRUNCATE posterior (lib.rs:1584-1605) encuentra 0 frames pero paga el fsync del fichero de DB multi-GB (~50 s). commit+checkpoint ≈ 80-90 s = sincronizar ~2× el tamaño de la DB (doble escritura WAL+backfill).

**Palanca futura (decisión pendiente):** cold sobre workspace virgen → construir la DB con `journal_mode=OFF`/`MEMORY` en fichero temporal + rename atómico (mismo estilo que index-pack import). Elimina la amplificación 2×: estimación −60/−100 s de cold. Trade-off: sin recuperación transaccional DURANTE el cold (aceptable: un cold fallido se reinicia de cero), y hay que garantizar que ningún lector abre el fichero hasta el rename.
