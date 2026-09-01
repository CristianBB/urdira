# F5-E1 (oxc_semantic + partición del walk): veredicto 2026-09-01

## Implementado (E1a/E1b/E1c + fixes)

- Módulo `semantic_sites.rs` (oxc_semantic; política conservadora rust_resolved; sitios pending con reason). Cutover: el checker visita SOLO pending_sites por descenso de spans con cursor incremental; deja de emitir references de sitios Rust; colisión = error de invariante.
- Regla `jsdoc_typed_file`: archivos .js/.jsx/.mjs/.cjs con JSDoc tipado quedan íntegros en el checker (40/2.000 en n8n; .ts verificado inmune).
- Paginación de filas híbridas en owners gigantes bajo AMBOS límites (4.096 filas + 4 MiB `MAX_BATCH_FRAMED_BYTES` del kernel — constante autoritativa re-exportada).
- **Bugs de producción encontrados y arreglados por el camino** (aplican también con el flag OFF): (1) referencias de cuerpos de constructor mal atribuidas al módulo (`ConstructorDeclaration.name?: never`); (2) referencias shorthand `{x}` inexistentes (falta de `getShorthandAssignmentValueSymbol`; recuperadas vía filas Rust, solo ON); (3) caché de `entityForDeclaration` que dejaba entidades sin tipo inferido en forward-references (afectaba al baseline; el cutover lo hizo visible); (4) dynamic `import()` sin site (ImportExpression ≠ CallExpression en oxc); (5) claves de propiedad string/privadas/numéricas sin identidad.
- Paridad por kind EXACTA on-vs-off a 2.000 owners; references +2.453 (ganancia neta); 5 misses residuales verificados a mano = imposibilidades de type-flow (suelo aceptado, clase Hallazgo B).

## Medición a escala completa (14.082 owners)

| | OFF (nueva ref.) | ON (×2 idénticos) |
|---|---:|---:|
| Cold | 564,3 s | 588,2 / 626,0 s |
| semantic generation | 195,8 s | 209,5 / 223,8 s |
| publish | 242,4 s | 247,8 / 268,3 s |
| Mutación | 121,6 s | 130,3 / 158,1 s |
| Digest cold | `sha256:70311fbd...` | `sha256:aafdbfee...` |
| Digest mut | `sha256:0c484940...` | `sha256:83c1b3c7...` |

**Veredicto: E1 aislada = ganancia de precisión, coste de rendimiento (+4-11% cold).** La partición conservadora no amortiza: el checker sigue pagando activación de ventanas, `getSemanticDiagnostics` (dominador del serverTime Go) y la mayoría de sitios (calls/member/typed pending); el descenso+merge añade overhead. Consistente con el diseño: el vuelco de signo se espera de E2 (resolutor → más rust_resolved y owners que se saltan Node) y E3 (calls) y sobre todo E4 (stage-3/diagnostics fuera del critical path).

## Decisión de orquestación

- `URDIRA_JSTS_HYBRID` queda **OFF por defecto** (no se adopta regresión de rendimiento). Los fixes incondicionales de precisión (constructores, caché de tipos, import() sites…) SÍ quedan en producción → nueva autoridad OFF: cold `sha256:70311fbd401b4ded5aa48326...`, mut `sha256:0c4849405ade9883faabce...` (2.000: `ad515872/2dcb686c`; determinismo full ×2 + verify en curso al escribir).
- La rama ON queda completa, gated, con autoridad propia registrada (`aafdbfee/83c1b3c7`) para comparaciones directas en E2/E3.
- Siguiente: E2 (resolutor de imports en Rust + assets de resolución al protocolo) y E3 (partición de calls); re-medición ON tras cada una; adopción de ON cuando el neto sea ≥ 0 en rendimiento (la precisión ya es superior).
