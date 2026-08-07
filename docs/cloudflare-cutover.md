# Supabase to Cloudflare cutover

This runbook moves the hosted Bellwire runtime to two Cloudflare Workers and
two D1 databases. It deliberately separates code readiness from external-state
changes. Creating resources, routing production traffic, and retiring the
Supabase project each require an explicit operator decision.

## Target resources

Record the real IDs and deployment results in a private operations record; do
not commit them here.

| Environment | Auth Worker | Auth D1 | API Worker | Business D1 |
| --- | --- | --- | --- | --- |
| Staging | `bellwire-auth-staging` | pending | `bellwire-api-staging` | pending |
| Production | `bellwire-auth` | pending | `bellwire-api` | pending |

The API Worker reaches Auth through `AUTH_SERVICE`. Public clients use the Auth
origin configured by `AUTH_ISSUER`; the expected JWT audience is
`bellwire-api`.

## 1. Freeze and export

1. Restore operator access to the source Supabase project.
2. Record source row counts for every business table, `auth.users`, Apple
   identities, and encrypted Apple refresh tokens.
3. Take a complete, encrypted backup before any write freeze.
4. Export a JSON snapshot whose top-level arrays use the source table names.
   Include `auth_users` and `auth_identities` for Supabase Auth records. The
   preparation command blocks user-owned data whose stable user ID or Apple
   identity mapping is missing.
5. Store the snapshot outside the repository and record its SHA-256 digest.

Do not put the snapshot, generated SQL, secrets, or user data in Git.

## 2. Prepare replay-safe imports

Create a new private output directory; the command refuses to overwrite one:

```bash
npm run migration:prepare -- \
  --snapshot /secure/bellwire-snapshot.json \
  --output /secure/bellwire-d1-import
```

The output contains `business.sql`, `auth.sql`, and `report.json`. Imports use
stable source IDs plus migration ledgers, so the same snapshot can be replayed
without creating duplicate domain rows. Inspect the report and SQL before
applying either file.

## 3. Prove staging

1. Create staging Auth and business D1 databases.
2. Apply `d1/auth/0001_auth.sql` and `d1/business/0001_bellwire.sql`.
3. Apply the generated Auth and business SQL to the matching databases.
4. Compare every source count with `report.json` and direct D1 queries.
5. Sample user, project, event, delivery, entitlement, waitlist, and Apple
   identity records by stable ID and checksum.
6. Deploy Auth first, then API. Verify Auth health, ES256 JWKS, API health,
   Apple sign-in and refresh, event ingestion, delivery, metering, and account
   deletion with disposable staging data.
7. Run the unsigned iOS build and a signed physical-device acceptance pass.

Any count, ownership, identity-link, or entitlement mismatch blocks cutover.

## 4. Production cutover

1. Provision production D1 databases and replace the zero UUID placeholders in
   private deployment configuration.
2. Apply both schemas and configure Worker secrets. Use the same
   `AUTH_INTERNAL_SECRET` on the two Workers and unique secrets everywhere
   else. The existing API Worker keeps its source `APPLE_TOKEN_ENCRYPTION_KEY`;
   the Auth Worker receives a new, independent `APPLE_TOKEN_ENCRYPTION_KEY`.
3. Announce a write freeze and stop source writes.
4. Capture a final snapshot, generate a fresh import directory, apply it, and
   reconcile counts and samples again.
5. Before deployment, set the same random `APPLE_TOKEN_REWRAP_SECRET` on Auth
   and API and temporarily configure `LEGACY_SUPABASE_URL` on API. Deploy Auth,
   verify `/health` and `/api/auth/jwks`, then deploy API. Invoke
   `POST /internal/migrations/apple-refresh-tokens` once with the rewrap secret.
   The API reads only the legacy ciphertext rows, decrypts them with the
   retained source key, passes plaintext only over the Auth service binding,
   and Auth stores and verifies ciphertext made with its new key. The response
   count must equal both the source token count and the imported Auth D1 count.
6. Delete `APPLE_TOKEN_REWRAP_SECRET` from both Workers, remove
   `LEGACY_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from API, redeploy, and
   confirm the migration endpoint returns `404`. The source encryption key may
   be rotated only after the APNs provider-token Durable Object compatibility
   has been handled separately.
7. Switch `auth.bellwire.app`, then `api.bellwire.app`, and validate public DNS,
   TLS, issuer, audience, sign-in, refresh, ingest, notification delivery, and
   account deletion.
8. Release the iOS build configured with `BellwireAuthBaseURL`. Existing local
   Supabase sessions are intentionally cleared and require one fresh Apple
   sign-in.

Keep the write freeze until public verification passes.

## 5. Rollback

Before changing routes, record the previous route and DNS configuration. If
Auth or API verification fails, restore both origins as a pair and keep the
source project read-write. Do not attempt to merge writes made independently
to both stores; either maintain the freeze or choose one authoritative store
before reopening writes.

Generated import files and the source snapshot are retained privately for
replay and forensic comparison. D1 databases are not deleted during rollback.

## 6. Retire Supabase

Retirement is a separate, destructive approval after the Cloudflare runtime
has passed an agreed observation window:

1. Confirm production no longer sends requests to Supabase.
2. Reconcile counts, checksums, entitlements, and account-deletion behavior one
   final time.
3. Preserve an encrypted final backup and its restore instructions.
4. Revoke Supabase runtime keys and monitor for unexpected callers.
5. Delete or pause the Supabase project only after explicit approval.

The checked-in `supabase/migrations` directory remains as historical source
schema and migration evidence; it is not a deployed runtime dependency.
