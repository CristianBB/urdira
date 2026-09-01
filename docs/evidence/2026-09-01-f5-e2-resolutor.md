# F5-E2: resolutor de imports completo en Rust (2026-09-01)

Shipped sin commit. Archivos: `crates/urdira-jsts-syntax-worker/src/resolver.rs` (nuevo, 1.538 líneas con 29 tests), lib.rs, semantic_sites.rs, main.rs (worker). Cero cambios TS, cero dependencias nuevas (parsers YAML/JSONC mínimos propios).

## Qué hace
- **T1**: `config_assets` (package.json, tsconfig/jsconfig con extends, pnpm-workspace.yaml) derivados de la MISMA frontier de fuentes (no hizo falta tocar TS: la ruta de producción deriva roots del frontier sin filtro). Sus digests entran en `configuration_digest` → cambio de paths/workspaces invalida el estado incremental (`ResetReason::ConfigurationChanged`).
- **T2**: resolutor determinista: workspace map (pnpm-workspace.yaml globs + package.json#workspaces), `exports` con condiciones fijas ["types","import","default"] probando TODAS las candidatas existentes (los .d.ts de dist no están en el corpus), paths/baseUrl con extends y semántica de no-merge real de tsconfig, máquina de extensiones reutilizada. Fuera de alcance documentado: node_modules de terceros, package.json#imports.
- **T3 lane 1 (incondicional)**: `resolve_relative` ELIMINADO; todos los DirectImport/export re-resueltos por el resolutor. **T3 híbrido (ON)**: cadena import→export→declaración única (1 salto de re-export; `export default`/`export *` nunca se adivinan → pending), caché por SymbolId (todos los usos del binding se resuelven), bug de doble emisión local/imported con mismo span cazado en vivo + regresión.

## Verificación
- cargo 87/87+33/33, clippy/fmt limpios, typecheck/build verdes, 4 suites vitest 52/53 (gold manifests sin cambios — verificado que ningún fixture tiene monorepo: la mejora no la ejercitan).
- Determinismo OFF×2 y ON×2 (2.000 owners) ✓; merge collisions=0 sobre 100.798 filas.
- ON vs OFF por kind: references **+4.258** (cross-file nuevas; 4 verificadas byte a byte contra el fuente), covers **−196 (BLOQUEANTE, fix en curso)**: la derivación de covers vive en analyzer.ts y solo ve referencias del checker; las cross-file de Rust se la saltan. OFF intacto. Resto delta 0.
- 5 ejemplos a mano: bare import workspace resuelto (`n8n-containers`→`packages/testing/containers/index.ts` vía main:"index.ts") + 4 referencias cross-file exactas.
- Owners con pending vacío (ON): 9/2.000 (TypedDecl sigue incondicional hasta E3/E4).

## Salvedades
1. **Metodológica**: los gates de este agente corrieron contra el checkout VIVO de n8n (HEAD b3a34fc), no el corpus retenido — sus digests NO reemplazan autoridades; la re-derivación sobre el corpus retenido va con el fix de covers.
2. **Limitación de corpus**: los paquetes centrales de n8n exportan `dist/**` (excluido del corpus) → la ganancia workspace en n8n está acotada por qué archivos se indexan; el resolutor en sí está probado exhaustivamente. n8n no usa tsconfig paths.
3. **Flakiness del harness (separada)**: la traza de 60 mutaciones falla en `import-01` con `resulting_corpus_digest does not match` (preexistente); con `--mutations 1` (content-00, la de la autoridad) no ocurre.
