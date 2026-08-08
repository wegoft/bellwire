# ADR-0005: Isolate authentication and business state on Cloudflare

Status: Accepted

## Context

ADR-0001 selected one shared protocol for hosted and self-hosted deployments,
and ADR-0002 separated user, Agent, and Ingest credentials. Their original
deployment details used Supabase Auth and PostgreSQL. Bellwire now needs one
Cloudflare-operated runtime, a separately deployable authentication boundary,
and a self-hosting path that does not require a second cloud provider.

## Decision

- Run an isolated Better Auth Worker with its own Auth D1 database.
- Keep Apple identity linking, signed 30-day session tokens, encrypted Apple
  refresh tokens, session revocation, and ES256 JWKS in that Auth boundary.
- Give the business API a separate D1 database and reach Auth through a Worker
  service binding for JWKS and account deletion.
- Present 15-minute ES256 access tokens with an exact issuer and
  `bellwire-api` audience to the business API. Agent and Ingest credentials
  keep the narrower scopes established by ADR-0002.
- Remove the legacy provider schema and one-time migration surface after the
  reconciled cutover is complete.

This supersedes the Supabase deployment detail in ADR-0001 and the Supabase
user-authentication detail in ADR-0002. Their protocol, deployment-mode, and
credential-separation decisions remain in force.

## Consequences

- Hosted and self-hosted installations each provision two Workers and two D1
  databases.
- Auth and business data cannot be joined directly; destructive account work
  crosses an authenticated internal service boundary.
- iOS receives public API/Auth origins but no provider key or server secret.
- Future storage migrations must again use explicit snapshot, reconciliation,
  traffic-switching, rollback, and retirement gates.
- Legacy local Supabase sessions require one fresh Apple sign-in after the app
  switches issuer.
