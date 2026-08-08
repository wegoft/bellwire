# Self-hosting Bellwire

Bellwire can run end to end in your Apple Developer and Cloudflare accounts.
The self-hosted stack uses two Workers and two D1 databases: one isolated Auth
Worker and one business API Worker.

## What you need

- An Apple Developer Program team with Push Notifications and Sign in with
  Apple enabled for your explicit App ID.
- App IDs for the main app, notification extension, and Widget/Live Activity
  extension, plus a shared App Group.
- An APNs `.p8` key, Key ID, and Team ID.
- A Cloudflare account with Workers, D1, Queues, and Durable Objects.
- Node.js 22 or newer, Wrangler, and Xcode.

## 1. Prepare Apple Developer

Register the three explicit App IDs, enable Push Notifications and Sign in with
Apple on the main App ID, create the App Group, and attach it to the main app
and Widget extension. Create an APNs authentication key and store its one-time
download outside the repository.

The same Apple private key is used by the Auth Worker to create the Apple client
secret and by the API Worker for APNs when the key has both capabilities. Keep
the values in Worker secrets, never in TOML or xcconfig files.

## 2. Create Cloudflare resources

Create two D1 databases and record their UUIDs:

```bash
npx wrangler d1 create bellwire-self-host-db
npx wrangler d1 create bellwire-self-host-auth-db
```

Create the delivery queues:

```bash
npx wrangler queues create bellwire-self-host-deliveries
npx wrangler queues create bellwire-self-host-deliveries-dlq
```

## 3. Generate local configuration

Use the D1 UUIDs printed by Wrangler:

```bash
npm run self-host:bootstrap -- \
  --team-id ABC123DEFG \
  --bundle-id com.example.bellwire \
  --url-scheme bellwire-self-host \
  --worker-name bellwire-self-host \
  --api-url https://bellwire-self-host.example.workers.dev \
  --auth-url https://bellwire-self-host-auth.example.workers.dev \
  --business-d1-id 11111111-1111-4111-8111-111111111111 \
  --auth-d1-id 22222222-2222-4222-8222-222222222222
```

The command creates three ignored files and refuses to overwrite any of them:

- `ios/Bellwire/Configuration/Local.xcconfig`
- `wrangler.self-host.toml`
- `wrangler.auth.self-host.toml`

The iOS file contains only public Worker origins and Apple identifiers. The two
Wrangler files contain resource bindings but no secrets.

## 4. Apply both D1 schemas

```bash
npx wrangler d1 migrations apply DB --remote -c wrangler.self-host.toml
npx wrangler d1 migrations apply AUTH_DB --remote -c wrangler.auth.self-host.toml
```

The business schema is in `d1/business`; the Better Auth schema is in
`d1/auth`.

## 5. Configure secrets

Generate two different random secrets with at least 32 characters: one Better
Auth secret and one internal secret. Set the same internal secret on both
Workers.

```bash
npx wrangler secret put AUTH_INTERNAL_SECRET -c wrangler.self-host.toml
npx wrangler secret put APNS_KEY_ID -c wrangler.self-host.toml
npx wrangler secret put APNS_TEAM_ID -c wrangler.self-host.toml
npx wrangler secret put APNS_PRIVATE_KEY -c wrangler.self-host.toml

npx wrangler secret put AUTH_INTERNAL_SECRET -c wrangler.auth.self-host.toml
npx wrangler secret put BETTER_AUTH_SECRET -c wrangler.auth.self-host.toml
npx wrangler secret put APPLE_SIGN_IN_KEY_ID -c wrangler.auth.self-host.toml
npx wrangler secret put APPLE_SIGN_IN_TEAM_ID -c wrangler.auth.self-host.toml
npx wrangler secret put APPLE_SIGN_IN_PRIVATE_KEY -c wrangler.auth.self-host.toml
npx wrangler secret put APPLE_TOKEN_ENCRYPTION_KEY -c wrangler.auth.self-host.toml
```

`APPLE_TOKEN_ENCRYPTION_KEY` is a random base64url-encoded 32-byte value. It
encrypts the Apple refresh token retained for account revocation.

## 6. Deploy and diagnose

Deploy Auth first so the API service binding resolves:

```bash
npx wrangler deploy -c wrangler.auth.self-host.toml
npx wrangler deploy -c wrangler.self-host.toml
npm run self-host:doctor -- --online
```

The doctor checks both Worker configs, both D1 bindings, the service binding,
iOS origins and identifiers, API health, Auth health, and the ES256 JWKS.

Validate the APNs key locally without persisting or printing it:

```bash
APNS_KEY_ID=ABC123DEFG \
APNS_TEAM_ID=ABC123DEFG \
APNS_BUNDLE_ID=com.example.bellwire \
APNS_ENVIRONMENT=sandbox \
  npm run self-host:apns-preflight < /secure/path/AuthKey_ABC123DEFG.p8
```

## 7. Physical-device acceptance

1. Build and install the app on a physical device.
2. Sign in with Apple and allow notifications.
3. Confirm the device appears in Settings.
4. Bind the Bellwire Skill with a one-time code.
5. Exercise a Private Direct v2 wake and verify on-device enrichment.
6. Exercise an approved Hosted project, schema, Surface, Ingest token, and Event.
7. Inspect delivery health and separately confirm device presentation.
8. Delete the test account and confirm both Auth and business D1 rows are gone.

Cloud resource creation, domain routing, production deployment, and account
deletion are intentionally explicit because they affect external state.
