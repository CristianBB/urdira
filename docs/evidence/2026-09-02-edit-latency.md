# Latencia de edición incremental tras la campaña (2026-09-02)

Corpus reconstruido `n8n-corpus-2026-09-02` (14.083 owners, = commit b3a34fcd81), digests de autoridad `7373757b`/`13e735a7` reproducidos exactos. Fixes de esta jornada: índice inline (A1), lexical con espera de lease (B1), rebuild re-encolado (B5), Merkle incremental de source_state_digest (A2), memoización de captured digest (A3), falso positivo de layout CAS, y **ANALYZE targeted inline en el cold** (el fix decisivo).

## Causa raíz del "edición > 2 minutos"

NO era el número de seeks ni estructura de query (el closures ya es una sola sentencia set-based). Era que **SQLite elegía el índice equivocado** (`record_occurrences_digest_order_idx`, solo workspace_id → full scan de 3,19M filas) por **no existir estadísticas** — producción nunca corría ANALYZE. Medido en fixture de 3,19M filas: sin ANALYZE 970s, con ANALYZE 158ms (~6000x). Descartadas con datos: analysis_limit acotado (insuficiente a esta escala), PRAGMA optimize por-publish (60% del publish), anti-join (sin mejora). Solución: `ANALYZE record_occurrences; ANALYZE identity_assignments;` inline al final del cold commit (~27s, fuera del critical path de edición).

## Desglose medido a 14k (run de 3 mutaciones)

| Scan | source_catalog | stage_plan | plugin_analyze | publish | closures | total |
|---|---:|---:|---:|---:|---:|---:|
| Primera edición (post-cold) | 288 ms | **12.513 ms** | 2.097 ms | 4.911 ms | 17 ms | 20,3 s |
| **Edición estacionaria** | 315 ms | **224 ms** | 2.197 ms | 6.363 ms | 9 ms | **9,9 s** |

Antes de la campaña la misma edición costaba **>120 s** (publish 96,5s con closures 89,5s + stage_plan 16s + espera de mantenimiento). Ahora:
- **Edición normal ≈ 10 s de cómputo** (`total` del scan, sin la ventana de estabilización del readiness).
- Primera edición tras cold ≈ 20 s: el residual es `stage_plan` 12,5s = el commit de fuentes esperando el writer lease que retiene el mantenimiento post-cold (FTS lexical + rebuild de índices). Se disipa en la 2ª edición (12,5s → 0,2s), confirmando que es contención transitoria, no coste de cómputo.

A 500 owners: edición de contenido 2,1s, de import 1,8s.

## Pendientes (palancas restantes, no bloqueantes)

1. **Primera edición**: los ~12s de espera de lease se eliminarían haciendo que el mantenimiento post-cold ceda ante una edición entrante (señal de scan-pendiente; B2/B3 del diagnóstico, no implementadas).
2. **Creación de archivo nuevo** a 14k: fuerza reconstrucción del manifiesto del proyecto; en este run agotó el timeout del worker (caso conocido de coste intrínseco alto — 73,5s histórico). Palanca propia: manifiesto incremental.
3. **publish estacionario 6,4s**: el visible_record_digest sigue siendo O(corpus) (~2s) por edición; digest incremental (A4 del diagnóstico) es la siguiente mejora, con riesgo de contrato de digest.
4. El `total` del harness no incluye la ventana de estabilización del readiness; la latencia percibida real está entre ~10s y esa ventana.
