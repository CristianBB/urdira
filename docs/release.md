# Release Process

This document is the operational checklist for Urdira 0.1.x. The normative
distribution contract is [decision 10](decisions/10-daemon-mcp-packaging.md);
the non-waivable qualification gates are [decision 08](decisions/08-performance-reliability-evaluation.md).

## Release channels

The primary public entry package is the dependency-free `urdira` bootstrap on
npm. The composed application is `@urdira/runtime` with its production
dependency closure under `@urdira/*`; it is prepared only after explicit user
confirmation. Packages are public and require Node.js `>=24.18.1`.
Deterministic platform archives are the secondary offline distribution and
already contain the runtime.

The source manifests remain private to prevent an accidental publish from a
workspace directory. `pnpm package:npm` creates clean public manifests in
`release/npm/staging`, packs them into `release/npm/tarballs`, and writes a
machine-readable manifest containing integrity values and publication order.

## One-time external setup

1. Create the public npm organization `@urdira` and verify that the unscoped
   `urdira` package name is controlled by the release owner.
2. Authenticate an npm account with two-factor authentication for the initial
   namespace bootstrap.
3. Configure npm trusted publishing for the exact public GitHub repository and
   release workflow. The workflow requires `id-token: write`; no long-lived npm
   token belongs in the repository.
4. Protect release tags and require the verification jobs.

See npm's official documentation for
[organizations](https://docs.npmjs.com/creating-an-organization/),
[public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
and [trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Creating the organization and publishing public scoped packages is free under
npm's public-package plan. The repository does not create the organization or
publish on behalf of a local verification run.

## Local qualification

Use the pinned runtime from `.nvmrc` and a clean checkout:

Node must resolve to `24.18.1` and npm must be at least `11.16.0`; runtime
preparation fails closed when the strict install-script policy is unavailable.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm preflight:windows
pnpm verify
pnpm audit --prod
pnpm package:npm:smoke
pnpm package:release
pnpm release:acceptance
git diff --check
```

CI runs the complete coverage, audit, publication, and npm-package gates once
on Ubuntu, and the complete ordinary test suite once on macOS. Windows runs the
focused portability preflight only: real portable filesystem staging plus path,
IPC, line-ending, storage, and publication-policy checks. This keeps native
Windows assurance without rerunning platform-independent integration scenarios.

Required outcomes:

- architecture, lint, type, generated-contract, test, and coverage gates pass;
- the production dependency audit reports no known vulnerabilities;
- all 13 npm tarballs contain only `dist`, `README.md`, `LICENSE`, and package
  metadata, with no `workspace:*`, testkit, fixture, source, or private path;
- a clean global npm prefix installs only the `urdira` bootstrap with no
  dependencies and no npm warning, then a separate temporary project installs
  the complete runtime closure under its exact reviewed script policy;
- `urdira --version` / `urdira --help` work before preparation, and the
  composed runtime CLI passes its own version/help smoke checks;
- deterministic archives pass inspection and acceptance; and
- publication hygiene finds no tracked editor/agent configuration, historical
  implementation plan, broken documentation link, host-local path, or stale
  package name.

## Stable qualification

Passing the local suite is necessary but not sufficient for a stable tag.
Before publication, archive release evidence showing:

- zero failures across correctness, determinism, crash, corruption, migration,
  watcher, and security scenarios;
- full/incremental equivalence and cursor replay at 100%;
- the 20-workspace / 50-client concurrent stress scenario;
- every declared P95 latency and resource ceiling across three independent
  runs and no unexplained regression above 10%; and
- benchmark inputs, runner version, raw-measurement digest, environment, and
  report digest.

The committed Vite campaigns are comparative agent-task evidence. They do not
replace the reliability, stress, or three-run P95 gates above. A flaky run is a
failure until its cause is identified.

## Publication

Review `release/npm/manifest.json`, then publish in its generated topological
order. The complete scoped runtime closure, including `@urdira/runtime`, must
publish before the dependency-free `urdira` bootstrap. Scoped packages require
public access. For a one-time interactive namespace bootstrap:

```bash
npm publish release/npm/tarballs/<package>.tgz --access public
```

After every package exists and trusted publishing is configured, release tags
should use the protected provenance-enabled workflow. Never publish from
`apps/` or `packages/` directly.

After publication, install `urdira` into a fresh global prefix and require an
empty npm warning stream. Verify version/help and the unprepared runtime
status, inspect `urdira runtime prepare --dry-run`, then confirm preparation.
Start `urdira mcp`, register a disposable JavaScript/TypeScript workspace,
confirm index readiness, execute one explicitly scoped query, and verify
pagination. Record bootstrap/runtime package integrity values, the preparation
manifest, and the release tag in the release notes.

## Rollback

npm versions are immutable. Do not overwrite or reuse a published version.
If a package is unusable, deprecate the affected version with a concise reason,
fix forward under a new semver version, and preserve the evidence needed to
understand the incident. Data-format or migration failures additionally follow
the recovery and compatibility contracts before a replacement release ships.
