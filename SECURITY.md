# Security policy

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Send a private report to the maintainers through the repository's configured security reporting channel. Include the affected version, impact, reproduction steps, and any suggested fix. Avoid including real credentials or private source code in the report.

## Security expectations

ThinkTrim treats repository text and model output as untrusted. Local-only inference is the default; remote repository-derived data requires explicit user configuration. Credentials must not be logged or stored in ordinary settings. See [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) for the project threat model.
