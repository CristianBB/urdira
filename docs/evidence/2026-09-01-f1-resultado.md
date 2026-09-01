# Resultado Fase 1 (publicación SQLite) — run de verificación 2026-09-01

Mismo harness y corpus que el baseline (`2026-09-01-fase0-baseline-instrumentado.md`). **Paridad de digest EXACTA**: cold `sha256:cdcf2468...`, mutación `sha256:ba617239...`. Exit 0.

## Cambios medidos (F1: drop/recreate extendido + ORDER BY estrechas + checkpoint cold + instrumentación commit)

| Métrica | Baseline | F1 | Δ |
|---|---:|---:|---:|
| Cold total (harness) | 946,8 s | 960,6 s | +13,8 s |
| plugin_analyze | 453,4 | 444,9 | −8,5 (ruido) |
| publish total (`rust core publish`) | 421,8 | 449,7 | +27,9 |
| — record_and_identity_promotion | 236,8 | 200,8 | **−36,0** |
| — dependency_promotion | 36,2 | 30,3 | −5,9 |
| — visible_record_digest | 55,6 | **82,7** | **+27,1 REGRESIÓN** |
| — cold_index_rebuild | 28,3 | 27,3 | −1,0 |
| — commit (nuevo, atribuido) | (en gap) | 28,4 | — |
| — checkpoint TRUNCATE (nuevo, movido al cold) | 0 | 49,4 | +49,4 deliberado |
| — residual sin atribuir del publish | ~64,9 | ~31 | −34 |
| **Mutación total** | **449,1 s** | **352,6 s** | **−96,5 s (−21%)** |
| — publish incremental | 98,6 | 19,1 | **−79,5** |
| — espera en BEGIN | ~94 s | 0 s | eliminada |
| — espera EEXIST (lexical retiene writer) | ~285 s | **~260 s** | apenas cambia |

## Lecturas

1. **La regresión del digest** (+27 s): el scan de `visible_record_digest` usaba `record_occurrences_workspace_owner_version_idx`, que F1 añadió a la lista de drop. Corrección ronda 2: recrearlo justo ANTES de la zona de digest (~4 s de CREATE INDEX sobre 3,2M filas) conservando los −36 s de la promoción. Neto esperado: −55 a −60 s vs baseline.
2. **El checkpoint en cold funcionó para lo que se diseñó**: publish incremental 98,6→19,1 s y BEGIN sin contención. Anomalía a investigar: `cold_checkpoint_ms=49399 busy=0 frames=0 checkpointed=0` — 49 s con 0 frames reportados (posible truncate/fsync de WAL gigante ya volcado por el commit; el commit_ms=28,4 s ya incluye el volcado).
3. **La palanca incremental nº1 sigue viva**: ~260 s de la mutación son la espera del retry tras `EEXIST` del writer-lock mientras el mantenimiento lexical detached (FTS 14k docs + índices secundarios) retiene el lease → Fase 2.
4. Residual del publish aún sin atribuir: ~31 s cold / ~14 s mutación (fuera de zonas+commit+checkpoint) — siguiente hueco de instrumentación.
5. ORDER BY: micro-bench del agente (3,2M filas, pragmas de producción): filas anchas con blob ordenar es 15-45% PEOR (se mantuvo sin ordenar, validando el comentario del código); filas estrechas 20-25% mejor (aplicado a dependencies y projection_value_nodes).
6. `graph_edges` no se puebla en la ruta Rust (verificado por grep) — sus índices no importan al cold actual. `record_facets` no tiene índices secundarios.
