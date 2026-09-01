# Autoridad de digest definitiva del modo por defecto (OFF) — 2026-09-01 (secuencia final)

Estado del árbol: rondas 1-5 + F5 E0-E3 con flag OFF por defecto. Incluye (incondicional): resolutor de imports E2 en lane 1 (bare imports de workspace resueltos, config_assets en configuration_digest), fixes de precisión del checker (constructores, caché de tipos de entityForDeclaration, directCallDeclaration sin re-resolve), dieta TEMP, F1-F4. `pnpm verify` VERDE (90,08% líneas, 1.949 tests).

| n8n completo (14.083 owners, corpus retenido) | ×2 idénticos |
|---|---|
| Cold | `sha256:5dfd38a9cfc7bc8f502bc2447351b1823...` |
| Mutación content-00 | `sha256:62c7b42be678f82ab09b8e3c89d25d68d...` |

Tiempos de los 2 runs: cold 572,7 / 562,2 s (semantic 201,4 / 179,1 s; publish 241,7 / 256,4 s); mutación 126,6 / 132,7 s.

**Progresión de la campaña (cold n8n): 946,8 s → ~562-573 s (−40%); mutación 449,1 → ~127-133 s (−71%).**

Rama ON (híbrido completo E1-E3): pendiente de su ×2 tras el fix de canonicalización por chunks del owner gigante (`useCanvasOperations.test.ts` >4.096 filas híbridas en un batch del kernel).
