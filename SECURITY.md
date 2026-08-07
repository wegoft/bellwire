# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, leaked credentials,
authentication bypasses, or privacy problems.

Email `feedback@bellwire.app` with `[SECURITY]` in the subject. Include the
affected component, reproduction steps, impact, and any suggested mitigation.
Avoid including real user data or active credentials. If sensitive material is
needed to reproduce the issue, ask for a secure transfer method first.

We aim to acknowledge a report within three business days and will coordinate
disclosure after a fix is available. This is a target, not an SLA.

## Supported versions

Until the first tagged stable release, security fixes are applied only to the
latest commit on the default branch and the current Bellwire Cloud deployment.
Forks and self-hosted deployments are responsible for applying updates and
rotating their own Apple, Cloudflare, Better Auth, Agent, and Ingest credentials.

## Secret handling

- Never commit `.dev.vars`, `.p8` files, Auth/internal secrets, APNs private keys,
  Agent tokens, or Ingest tokens.
- The public Auth Worker origin is not a credential; authorization is enforced
  by short-lived JWTs and server-side ownership checks.
- If an actual secret reaches Git history, revoke or rotate it before removing
  it from the repository. History rewriting alone does not make it safe again.
