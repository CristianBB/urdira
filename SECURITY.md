# Security Policy

## Supported versions

Security fixes are provided for the latest published `0.1.x` release. Before
the first npm publication, the `main` branch is the only supported line.

## Reporting a vulnerability

Please use GitHub's private security-advisory flow for this repository. Do not
open a public issue containing an exploit, credential, private source excerpt,
or sensitive host path.

Include the affected Urdira version and platform, the smallest reproducible
input, expected and observed behavior, impact, and any relevant logs after
removing secrets and local paths. Reports involving source disclosure should
use a synthetic repository whenever possible.

The project will acknowledge a complete report, reproduce it, assign severity,
and coordinate a fix and disclosure. No response-time guarantee is offered for
this initial community release.

## Security boundary

Urdira's public MCP surface is read-only and local. It does not expose source
editing, patch application, arbitrary command execution, or a network
transport. Administrative CLI actions use explicit preview and confirmation.
Language analyzers run behind the plugin supervision contract, and public
queries require explicit workspace scope.

Security guarantees and adversarial acceptance criteria are defined in
[configuration, security, and lifecycle](docs/decisions/09-configuration-security-lifecycle.md)
and [performance, reliability, and evaluation](docs/decisions/08-performance-reliability-evaluation.md).
