<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security model and operations

## Trust boundaries

- The public Auth Worker handles Apple identity exchange and issues short-lived
  ES256 access tokens. Its Auth D1 and Apple token-encryption secret are isolated
  from the business API.
- The API Worker authenticates user JWTs or scoped Agent tokens before owned
  resource access. Hosted ingestion uses project-scoped Ingest tokens.
- Private delivery sends only an opaque wake through Bellwire infrastructure;
  the device fetches content from the user's signed HTTPS service.
- APNs, Apple, Cloudflare, and an optional PostHog instance are external trust
  boundaries. A healthy Worker does not by itself prove those providers are
  available.
- Self-hosted operators own account security, secrets, domain routing, data
  retention, backups, costs, and incident response.

Primary threats include credential theft, cross-account authorization mistakes,
replayed Direct requests, malicious event payloads, notification data leakage,
dependency compromise, and destructive schema changes. Controls include scoped
tokens, ownership checks, signed Direct v2 requests, timestamp/replay checks,
bounded JSON bodies, sensitive-field restrictions, immutable CI actions, CodeQL,
Dependabot, migration review, and secret-free local configuration.

## Backup and restore

Back up both D1 databases before migrations and periodically according to the
deployment's recovery objectives. Store exports outside the repository with
restricted access. A backup is not considered valid until it has been restored
into separate D1 databases and its Auth and owned-resource queries have been
verified. Record the associated code version and migration set with each backup.

Worker rollback and data restore are separate operations. D1 migrations are
forward-only in automation; see [the upgrading guide](upgrading.md).

## Incident response

1. Preserve relevant logs and identify the affected deployment, identities,
   resources, credentials, versions, and time window.
2. Contain access by revoking or rotating the narrowest affected Cloudflare,
   Apple, APNs, Auth, Agent, Ingest, or PostHog credential. Do not print secrets
   while investigating.
3. Patch and validate in an isolated environment, including authorization and
   provider-boundary checks.
4. Restore or forward-repair data from a tested backup when necessary; do not
   assume Worker rollback reverses a D1 migration.
5. Notify affected operators or users and coordinate disclosure under
   [SECURITY.md](../SECURITY.md).
6. Document root cause, timeline, corrective actions, and any new regression
   test without publishing active credentials or user data.
