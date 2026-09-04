# Diagnóstico: creación de archivo agota el timeout a 14k (2026-09-02)

## Causa
Crear/borrar/renombrar un archivo cambia el file-set/root-set del proyecto → rebuild completo O(corpus) en ambas capas, NO incremental. Editar CONTENIDO de un archivo existente deja el path-set intacto → camino incremental (owner cambiado + cierre inverso).

- **Syntax worker (Rust)**, `crates/urdira-jsts-syntax-worker/src/lib.rs:893-901`: `paths != prior_paths` → `ResetReason::FileSetChanged` (o `RootSetChanged`) → `next_files` vacío (re-parsea 14k fuentes, :965), `affected = paths` completo (:1045), `BuildKind::Full`. Sin reset, `reverse_affected_closure` (:2308) da solo el path cambiado + dependientes.
- **Checker (TS)**, `packages/plugin-javascript-typescript/src/analyzer.ts:2132` y `canUpdate` :2169-2171: root-set distinto → descarta snapshot, reconstruye `fileMap` completo, `api.updateSnapshot({openProjects:[configPath]})` re-prepara el programa TS con 14k roots (:2207). El "manifest" es el config `{compilerOptions, files: rootNames}` (SESSION_CONFIG_FILE, :847/:2182), equivalente a `tsconfig.files`.
- Elección deliberada (analyzer.ts:770-776): un archivo nuevo puede cambiar la resolución de módulos de archivos existentes, así que la memoización por-archivo "no se considera fiable".

## El timeout
`packages/plugin-javascript-typescript/src/indexing-core-process-transport.ts:164` — timeout por-request FIJO (no basado en progreso). Valor: `apps/urdira/src/index.ts:1967-1969` = `Math.min(600_000, env)` = **600 s techo duro** (el validador del transport, :74-78, además rechaza >600.000). La generación es un único request → todo el engine debe caber en 600 s. A 14k el rebuild O(corpus) los supera → `core:workspace_scan_failed`. A 500 owners (25,5s) o histórico (73,5s) no llegaba al techo.

## Fixes
(a) **Parche mínimo**: subir el techo del timeout (dos sitios) o convertirlo en timer basado en progreso/`deadline_ms` que se reinicie con eventos `progress`. NO arregla la causa; solo evita el fallo mientras el rebuild siga O(corpus). Útil como escalón para establecer el digest-oráculo de una creación.

(b) **Fix de fondo — alta incremental de root**: cuando `rootNames` es superset del previo y `compilerOptions` no cambia:
- Syntax worker: no vaciar `next_files` (reusar `prior` para paths sin cambio); `changed`/`affected` = path nuevo + `reverse_affected_closure` + los archivos cuyos imports antes NO resueltos ahora apuntan al archivo nuevo (el resolutor E2 puede computarlo).
- Checker: camino "add-root incremental" en `prepareRustSemanticState` que use `updateSnapshot({fileChanges:{added:[...]}})` en vez de `openProjects`, apoyándose en que un archivo nuevo sin importadores no invalida resolución existente.

Corrección: la parte delicada es "imports antes no resueltos que ahora resuelven al archivo nuevo" — esos importadores SÍ están afectados. El resto del corpus no. Verificación: el digest de una creación con el camino incremental debe ser IDÉNTICO al del rebuild completo (verificable a 500/2000 owners, coste-escala independiente, como el test de equivalencia del Merkle).

## Plan de implementación
1. Establecer el digest-oráculo de create-02 a 2.000 owners (rebuild completo actual, que ahí SÍ completa).
2. Implementar (b); verificar digest idéntico al oráculo a 2.000; medir speedup a 14k.
3. (a) como red de seguridad para operaciones legítimamente largas restantes.
