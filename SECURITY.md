# Security Policy

## Supported Versions

Security fixes apply to the latest release on the `0.x` line (`main` branch).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue with exploitable details, OAuth tokens, credentials, or raw request captures.

Instead, report vulnerabilities privately through GitHub Security Advisories on this repository (or contact the maintainer directly via GitHub). Include:

- Affected version (`package.json` version / commit)
- Component (`src/dsh/rpc.ts`, `src/core/oauth.ts`, `src/core/credentials.ts`, `client.js`, etc.)
- Minimal reproduction steps with dummy/redacted inputs

## Security Design Invariants

- **Loopback guard**: Both account (`/api/antigravity-gateway-account/*`) and diagnostic log (`/api/antigravity-gateway-logs/*`) RPC routes as well as `/agw` commands fail closed with `loopback-required` unless the DSH Host has no WebServer or its WebServer is explicitly bound to `127.0.0.1`.
- **Credential storage**: Refresh/access tokens are stored in DSH's credential store (`dsh-antigravity-gateway/google-account`) and mirrored via atomic writes to an owner-only (`0600`) file (`credential.json`), never in plugin config or logs.
- **PKCE OAuth**: The PKCE `verifier` stays in Host memory only; the callback server binds strictly to `127.0.0.1`.
- **Log redaction**: `PluginLogger` scrubs configured secrets, `Bearer` headers, `ya29.` access tokens, `1//` refresh tokens, and common key/secret patterns; message bodies and tool arguments are never logged (the opt-in `dumpRequestsTo` diagnostic is disabled by default).
