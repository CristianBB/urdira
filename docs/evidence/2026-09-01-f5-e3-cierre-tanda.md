# F5 E3 + cierre de tanda del híbrido — 2026-09-01

## E3 shipped (calls + heritage desde Rust)
- Calls: callee identificador con declaración única función/clase (binder local o cadena resolutor E2) → `core:call` confirmed desde Rust (11,0% de los call sites a 2.000 owners); member/this/super/new/sobrecargas → checker. `jsts:unresolved_call` íntegro en el checker.
- Heritage: identificador simple no genérico → Rust (52,6%); cualificado/genérico/anónimo → checker. **Bug cazado en vivo**: resolución atómica por cláusula multi-tipo (el descenso del checker recolapsa la cláusula entera → doble emisión); fix `heritage_clause_partially_pending` + 3 regresiones.
- Paridad por kind EXACTA en calls/inherits/implements. **Decisión de orquestación** (bajo la autorización vigente "precisión igual o mejor"): −4.675 `jsts:unresolved_call` en ON ACEPTADO como mejora — son 6.006 llamadas que el checker marcaba unresolved por bug preexistente de `directCallDeclaration`/`getResolvedSignature` (reproducido aislado sin híbrido); mismas aristas, mejores clasificaciones, menos falsos diagnósticos.
- Otro bug de producción cazado al testear cobertura: el resultado de `directCallDeclaration` se re-resolvía → TypeError silencioso → calls directas degradadas a possible. Arreglado (analyzer.ts).
- Owners gigantes: canonicalización de filas híbridas ahora troceada bajo ambos límites del kernel (bisección recursiva, equivalencia byte a byte probada) — tercer punto del mismo problema de escala (tras paginación por filas y por bytes).

## Autoridades finales (n8n completo, corpus retenido, ×2 idénticos cada una)

| Modo | Cold | Mutación |
|---|---|---|
| **OFF (default de producción)** | `sha256:5dfd38a9cfc7bc8f...` | `sha256:62c7b42be678f82a...` |
| ON (híbrido E1-E3) | `sha256:7373757b05bc5969...` | `sha256:13e735a7e17ad1e0...` |

## Rendimiento final de la tanda (n8n completo)

| | OFF | ON |
|---|---:|---:|
| Cold | 562,2 / 572,7 s | 582,3 / 614,7 s |
| semantic generation | 179,1 / 201,4 s | 204,1 / 217,9 s |
| publish | 241,7-256,4 s | 249,2-268,3 s |
| Mutación | 126,6 / 132,7 s | 129,9 / 138,8 s |

**Veredicto del híbrido tras E1-E3: precisión estrictamente superior** (references +4.258/2k, covers +1, −4.675 falsos unresolved, 7 bugs de producción arreglados por el camino) **pero rendimiento ~+4-7% peor**. El coste marginal es el overhead de parse+SemanticBuilder+merge de ~700k filas y el residual del checker (diagnostics ≈ dominador del serverTime Go, member refs, typed decls, ventanas) que E1-E3 no tocan. La palanca restante del diseño es **E4** (stage-3 diferido post-ready: diagnostics + inferred types fuera del critical path, patrón lexical) — GO/NO-GO del dueño porque cambia el contrato de readiness.

`pnpm verify`: VERDE (90,08% líneas, 1.949 tests) sobre el árbol completo.

## Progresión total de la campaña (un día)

| Métrica | Inicio | Final (OFF default) |
|---|---:|---:|
| Cold n8n completo | 946,8 s (21m58s elapsed histórico: 1.318 s) | **~562-573 s (−40%)** |
| Mutación 1 archivo | 449,1 s | **~127-133 s (−71%)** |
| Precisión | baseline | +referencias shorthand, constructores bien atribuidos, imports cross-package resueltos, tipos en forward-refs, calls directas confirmed |
