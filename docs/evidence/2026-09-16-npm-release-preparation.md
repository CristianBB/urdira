# npm 0.4.0 release preparation

Status: prepared locally; publication is pending the protected multi-target
workflow and npm trusted-publishing authentication.

## Coordinates

- Application and production package coordinate: `0.4.0`.
- JavaScript/TypeScript plugin coordinate: `0.6.0`.
- Native binding API: `18`.
- Native target matrix: `darwin-arm64`, `darwin-x64`, `linux-arm64-gnu`,
  `linux-x64-gnu`, and `win32-x64`.

## Verification

- `CI=true pnpm verify`: passed (168 files, 2,587 tests, 90.10% measured
  lines, publication hygiene passed).
- `CI=true pnpm test tests/release-version-authority.test.ts tests/npm-packaging.test.ts tests/runtime-bootstrap.test.ts tests/app-runtime.test.ts tests/phase24-web.test.ts`: passed (64 tests).
- `CI=true pnpm package:npm:smoke`: passed for the local `darwin-arm64`
  closure; bootstrap installation was warning-free and runtime `0.4.0` passed
  version/help smoke checks.
- The local native build produced the macOS arm64 addon, syntax worker, and
  indexing worker. Other targets are built by the matrix in
  `.github/workflows/publish.yml`.

## Publication boundary

The npm registry currently lacks the new `0.4.0` coordinates and all five
platform packages. The local npm session is unauthenticated (`npm whoami`
returns HTTP 401), so publication must run through the repository's trusted
publisher workflow after a signed `v0.4.0` tag exists. The workflow stages all
15 production packages plus the five native packages, checks exact integrity,
and publishes in dependency order.
