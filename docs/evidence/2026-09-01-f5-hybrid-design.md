# Diseño Fase 5: lane semántico híbrido (oxc_semantic + resolutor Rust + tsgo residual)

Autorizado por el dueño (variante con pase tsgo residual). Base de medición: semantic ~250 s wall, de los que ~90% es walk JS en analyzer.ts (1,35M requests IPC = 147 s repartidos en 6 lanes ≈ 25 s wall; serverTime Go 95 s ≈ 16 s wall, dominado por getSemanticDiagnostics).

## Hallazgos que condicionan el diseño

- **A. Identidad divergente entre productores**: Rust usa `identifier.span.start` (lib.rs:1792), el checker `node.getStart()` de la declaración (analyzer.ts:1498). Unificar en "start del identificador de nombre" (cambio en analyzer.ts; Rust ya lo hace; offsets UTF-16 compatibles vía Utf8ToUtf16 lib.rs:1689).
- **B. Member-access (`a.b.c`) es trabajo intrínseco del checker** (resolución por tipo): 25-40% de los lookups. Es el suelo del residual tsgo — no se promete eliminarlo.
- **C. El punto de fusión ya existe**: el syntax worker es biblioteca dentro de urdira-indexing-worker; `process_owner` (main.rs:3263) puede anexar filas Rust al staging del mismo work item sin IPC ni cambios del modelo de publicación.
- **D. Gold manifests son por anchor**, no por record_id — sobreviven al re-keying; solo se renegocian si cambia una classification o aparece/desaparece una relación.

## Etapas

### E0 — Unificación de identidad + arnés oráculo (prerequisito)
Identidad unificada `jsts:{kind}:{path}:{nameIdentifierStart}:{name}` en ambos productores (editar entityForDeclaration/nodeKey en analyzer.ts). Modo `URDIRA_JSTS_HYBRID_ORACLE=1`: ambos productores por owner, diff de filas canónicas en vez de publicar. Gate: verify + gold + 2000×2 determinista + run n8n → primera adopción de digest.

### E1 — oxc_semantic: references intra-archivo desde Rust (etapa mayor)
`oxc_semantic =0.142.0` en el syntax worker; `SemanticBuilder` tras el parse. Módulo `semantic_sites.rs`: tabla de entidades anidadas (réplica de rustSemanticDeclarationShape, incl. la semántica ownerAt de analyzer.ts:1568-1583 — arrow en variable → owner módulo) + **tabla de sitios** `{start,end,site_kind,disposition∈rust_resolved|checker_pending,reason}`. Regla del contrato: **Rust solo emite lo que puede probar léxicamente; la duda va al checker**. rust_resolved en E1 = identificador con symbol local/parámetro/misma-declaración-única del archivo; member access, imports, multi-declaración, this, JSX → pending.
Handoff: `read_owner_semantics(project_key, owner_path) → {rust_rows, pending_sites, sites_digest}`; el orquestador anexa rust_rows en process_owner, embebe pending_sites en semantic_request, y **si pending vacío y sin stage-3, el owner no viaja a Node**. El walk JS pasa de collectAll a localizar solo los sitios pendientes por descenso de spans. Doble contabilidad imposible por partición; verificada por oráculo.
Ganancia: semantic → ~130-150 s.

### E2 — Resolutor de imports completo en Rust
Assets nuevos al protocolo (package.json, tsconfig con extends/paths/baseUrl, pnpm-workspace.yaml; sus digests entran en configuration_digest). **Resolutor propio recomendado** (~300-500 líneas: mapa workspace-package→raíz, exports/main/types con orden de condiciones fijo ["types","import","default"], paths, y la máquina de extensiones de resolve_relative); oxc_resolver como plan B. Cierra import→export→declaración única (incl. re-exports) → esos sitios pasan a rust_resolved. Arregla la cobertura cross-package hoy rota. E2b (aparte, gate propio): inyectar paths al proyecto tsgo — delta enorme de diagnostics, posponer a después de E3.
Única etapa que AUMENTA cardinalidad (aristas confirmed nuevas). Ganancia: → ~90-115 s.

### E3 — Partición typed/untyped de calls y heritage
Rust absorbe y amplía directCallDeclaration: call a identificador con binding único sin sobrecargas → confirmed desde Rust; member calls/this/new-sobrecargado/interfaz → checker. `jsts:unresolved_call` queda íntegro en el checker (solo él afirma "ninguna declaración"). Heritage simple → Rust; cualificado/mixins → checker. Ganancia: → ~60-80 s.

### E4 — Stage 3 diferido post-ready (GO/NO-GO con el dueño tras medir E3)
Separar las generaciones stage_2 (→ structural_ready) y stage_3 (post-ready, patrón lexical descontendido). Puntos duros que requieren decisión: semántica de readiness sin tipos/diagnostics, digest del preflight tras B (o doble autoridad ready-set/full-set), en qué generación viaja covers. GO solo si stage-3 ≥40 s del crítico tras E3. Ganancia si GO: crítico → ~30-45 s.

### E5 — Adopción de digest por etapa (transversal)
Proceso fijo (docs/evidence/2026-09-01-digest-authority-change.md): build completo siempre; determinismo 2000×2 + n8n×2 (+estabilidad a nº de lanes); conciliación de cardinalidad por record_kind (delta≠0 solo esperado en E2/E4); inspección de muestras; verify verde (cobertura ≥90%); gold manifests; doc de evidencia con digests viejos/nuevos.

## Estimación

| Etapa | semantic wall |
|---|---:|
| Hoy | ~250 s |
| E1 | ~130-150 s |
| E2 | ~90-115 s |
| E3 | ~60-80 s |
| E4 (GO) | ~30-45 s crítico + 40-60 s post-ready |

Cold completo tras E1-E4 con publish actual: ~530-560 s; combinado con la vía del publish: **~350-420 s**.

## Riesgos (en orden)
1. Paridad binder/checker (merging de declaraciones, CommonJS) — mitigada por "lo dudoso queda pending" + oráculo.
2. Identidad entre productores — resuelta estructuralmente en E0.
3. Doble emisión — imposible por partición + assert de colisión en process_owner.
4. E4 toca el contrato de readiness — GO/NO-GO explícito.
5. Suelo de member-access — asumido y documentado.

## Archivos críticos
- crates/urdira-jsts-syntax-worker/src/lib.rs (oxc_semantic, semantic_sites, resolutor)
- crates/urdira-indexing-worker/src/main.rs (run_jsts_semantic_generation:3162, process_owner:3263, semantic_request:3022)
- packages/plugin-javascript-typescript/src/analyzer.ts (walk:1375, grupos:2012, identidad E0)
- packages/plugin-javascript-typescript/src/fact-delta.ts (formato canónico a replicar byte a byte)
- apps/urdira/src/index.ts (stage mapping:615-619, stage groups:559, assets E2)
