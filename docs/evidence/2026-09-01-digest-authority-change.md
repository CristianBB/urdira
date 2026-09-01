# Cambio de digest de autoridad del corpus n8n (2026-09-01)

**Decisión del dueño (2026-09-01):** adoptar como nueva autoridad el visible-set digest que produce el árbol fuente actual compilado al completo, condicionado a `pnpm verify` verde.

| | Digest cold | Digest mutación content-00 |
|---|---|---|
| Autoridad anterior (runs 2026-08-31 → f1c) | `sha256:cdcf2468...` | `sha256:ba617239...` |
| **Nueva autoridad** | `sha256:f818096cbc907a36851bd...` | `sha256:8551f5b069ebc4acf4a45...` |

## Por qué

Tras la ronda 2 de optimización (F1-r2 índice digest inline, F3a lanes contiguos, F3b RSS, F2/F2-r2 descontención lexical) el digest dejó de coincidir con la autoridad. Investigación realizada:

- **Determinismo probado**: el digest nuevo es idéntico en 5 runs (r2, r3, evict800, y ambos digests del bisect), estable frente a nº de lanes (1 vs 6), partición, límite RSS (800MB vs 1,5GB) y escala (2.000 y 14.083 owners).
- **Mismo conjunto**: 3.183.253 filas estructurales en TODOS los runs (viejos y nuevos) — difiere el contenido de algunas filas, no la cardinalidad.
- **Exoneraciones por bisect**: partición de lanes (run C: 1 lane = mismo digest que 6), presupuesto RSS/evicción (run B y evict800 full-scale: mismo digest con 800MB), orden del scan del digest (el SQL lleva `ORDER BY record_id`, colación BINARY, independiente del plan; main.rs:3473).
- **Atribución imposible de cerrar**: `crates/` no estaba trackeado en git (sin historia) y el worktree arrastraba ~60 ficheros TS modificados sin commit de la sesión anterior. Los runs con paridad (baseline, f1c) corrieron con dist TS **parcialmente** recompilado; los runs sin paridad, con dist completo. Es plausible (no demostrable: la DB del run de autoridad ya no existe) que la autoridad anterior correspondiera a dist obsoleto que no representaba el código fuente.

## Mitigaciones adoptadas

1. `crates/` + Cargo.* + fuzz/ añadidos al índice de git (214 ficheros, 18.586 líneas) — todo cambio Rust es diffeable desde ahora.
2. `pnpm verify` completo como gate de esta adopción (resultado en este doc al cerrar).
3. Regla operativa: antes de cualquier run de benchmark, `pnpm -r build` completo (nunca builds filtrados) — la mezcla de dist fue la que hizo inatribuible este cambio.
4. Chequeo de estabilidad barato disponible: dos runs de 2.000 owners deben producir digest idéntico (`scripts/n8n-incremental-preflight.mjs --owners 2000`).

## Estado de verificación — ADOPTADA

- Gold manifests (confirmed/possible streams), e2e de producción, suites de plugin/publicación: verdes.
- `pnpm verify` completo con todo el árbol integrado (rondas 1-4): **VERDE, exit 0** (2026-09-01) — ~1.950 tests, cobertura de líneas 90,03% (gate ≥90% restaurado tras días por debajo), higiene de publicación 790 ficheros.
- Reproducción de la autoridad confirmada en el run r4b: cold `f818096...` y mutación `8551f5b...` exactos con F4+dieta integrados.
