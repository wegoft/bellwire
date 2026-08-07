# Self-hosting Bellwire

Bellwire can run end to end on infrastructure you control. A self-hosted build
does not use Bellwire Cloud, its Apple signing identity, or its APNs credentials.

## What you need

- An Apple Developer Program team with Push Notifications and Sign in with
  Apple enabled for your own explicit App ID.
- Two extension App IDs: one for the notification service and one for Widgets
  and Live Activities.
- An App Group shared by the main app and Widget extension.
- An APNs token signing key (`.p8`), Key ID, and Team ID.
- A Supabase project for authentication and PostgreSQL storage.
- A Cloudflare account with Workers and Queues.
- Node.js 22 or newer, Wrangler, Supabase CLI, and Xcode.

Cloudflare alone is not sufficient. The current server stores durable state and
authenticates users through Supabase, while APNs only accepts notifications
signed by the Apple Developer team that owns the app's Bundle ID.

## 1. Prepare Apple Developer

In Certificates, Identifiers & Profiles:

1. [Register an explicit App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id)
   for the main app, for example `com.example.bellwire`.
2. Enable Push Notifications and Sign in with Apple on that main App ID. For a
   new independent app, configure it as the primary Sign in with Apple App ID.
3. Register a second explicit App ID for the notification extension, for
   example `com.example.bellwire.NotificationService`.
4. Register a third explicit App ID for the Widget and Live Activity extension,
   for example `com.example.bellwire.Widgets`.
5. Register an App Group such as `group.com.example.bellwire.shared`, then
   enable it for the main App ID and Widget extension App ID.
6. [Create an APNs authentication key](https://developer.apple.com/help/account/keys/create-a-private-key),
   record its Key ID, and download its `.p8` file. Apple only offers the private
   key download once, so store it securely and never add it to Git.

The repository already declares the app-side Push Notifications, Sign in with
Apple, Widget, Live Activity, and App Group entitlements. Xcode will still need
permission to create matching provisioning profiles for all three identifiers.

## 2. Prepare Supabase

Create a fresh project, link it from this repository, and apply every migration
in `supabase/migrations`:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

In Authentication > Providers > Apple, enable the provider and add the main
App ID as a Client ID for native ID-token login. Supabase's
[Apple provider guide](https://supabase.com/docs/guides/auth/social-login/auth-apple)
describes additional Services ID and secret setup if you later add web OAuth.

Copy the project URL and a publishable key for the bootstrap command below.
Keep the secret/service-role key server-side only; the iOS build receives only
the publishable key. Supabase documents the intended split in its
[API key guide](https://supabase.com/docs/guides/getting-started/api-keys).

## 3. Generate local configuration

Generate both ignored local configuration files with one command:

```bash
npm run self-host:bootstrap -- \
  --team-id ABC123DEFG \
  --bundle-id com.example.bellwire \
  --url-scheme bellwire-self-host \
  --worker-name bellwire-self-host \
  --api-url https://bellwire-self-host.example.workers.dev \
  --supabase-url https://YOUR_PROJECT_REF.supabase.co \
  --supabase-publishable-key sb_publishable_YOUR_KEY
```

The bootstrap command creates `ios/Bellwire/Configuration/Local.xcconfig` and
`wrangler.self-host.toml`, refuses to overwrite either file, and never asks for
or writes server-side secrets. Run it with `--help` to see optional Bundle ID,
Queue prefix, URL scheme, and APNs environment settings.

The generated iOS configuration contains:

- `BELLWIRE_DEVELOPMENT_TEAM`: your Apple Team ID.
- `BELLWIRE_APP_BUNDLE_ID`: your explicit main App ID.
- `BELLWIRE_EXTENSION_BUNDLE_ID`: the notification service extension App ID.
- `BELLWIRE_WIDGET_BUNDLE_ID`: the Widget and Live Activity extension App ID.
- `BELLWIRE_APP_GROUP`: the App Group shared by the main app and Widget.
- `BELLWIRE_URL_SCHEME`: a URL scheme unique to your build.
- `BELLWIRE_API_BASE_URL`: your deployed Worker URL.
- `BELLWIRE_SUPABASE_URL`: your Supabase project URL.
- `BELLWIRE_SUPABASE_PUBLISHABLE_KEY`: your Supabase publishable key.

If you prefer manual setup, copy `Local.xcconfig.example` to
`Local.xcconfig` and `wrangler.self-host.example.toml` to
`wrangler.self-host.toml`, then replace every example value. Keep iOS URL
values in the `https:/$()/host` form shown in the example. The empty
build-setting expression prevents xcconfig from parsing `//` as a comment.

Open `ios/Bellwire/Bellwire.xcodeproj` after configuring the identifiers. Xcode
must be able to create provisioning profiles for all targets. A Simulator
build verifies compilation, but a signed physical-device build is required to
obtain a real APNs device token.

## 4. Configure Cloudflare

Review the generated `wrangler.self-host.toml`. Create the delivery Queue and
dead-letter Queue named in that file, then store the required secrets:

```bash
npx wrangler queues create bellwire-self-host-deliveries
npx wrangler queues create bellwire-self-host-deliveries-dlq
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c wrangler.self-host.toml
npx wrangler secret put APNS_KEY_ID -c wrangler.self-host.toml
npx wrangler secret put APNS_TEAM_ID -c wrangler.self-host.toml
npx wrangler secret put APNS_PRIVATE_KEY -c wrangler.self-host.toml
npx wrangler secret put APPLE_TOKEN_ENCRYPTION_KEY -c wrangler.self-host.toml
```

Wrangler prompts for each value and stores it as an encrypted Worker secret;
do not paste these values into the TOML file. Generate
`APPLE_TOKEN_ENCRYPTION_KEY` as a random base64-encoded 32-byte value. The
generated Wrangler configuration provisions the global APNs provider-token
Durable Object on first deploy. See Cloudflare's official guides
for [Queue creation](https://developers.cloudflare.com/queues/get-started/) and
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Deploy with the local configuration:

```bash
npx wrangler deploy -c wrangler.self-host.toml
```

The `APNS_BUNDLE_ID` and `APP_URL_SCHEME` values in the Worker configuration
must exactly match the iOS build. Use `APNS_ENVIRONMENT = "sandbox"` for a
development-signed device build and `"production"` for an App Store,
TestFlight, or production-signed build.

## 5. Verify the complete path

Check local configuration consistency before provisioning or deploying:

```bash
npm run self-host:doctor
```

After deployment, include reachability checks for the Worker and Supabase:

```bash
npm run self-host:doctor -- --online
```

The online result includes the Worker-reported App, API, and latest required
database migration versions. It verifies service reachability, not whether the
database migrations were actually applied.

Validate that the APNs private key can produce a provider token without saving
or printing the key:

```bash
APNS_KEY_ID=ABC123DEFG \
APNS_TEAM_ID=ABC123DEFG \
APNS_BUNDLE_ID=com.example.bellwire \
APNS_ENVIRONMENT=sandbox \
  npm run self-host:apns-preflight < /secure/path/AuthKey_ABC123DEFG.p8
```

Add `-- --online` to let APNs validate the provider token and topic with a dummy
device token. The probe cannot deliver a notification. Match the environment to
the signing type described above.

Run the destructive-but-self-cleaning API smoke test against the self-hosted
deployment. It creates a temporary confirmed Supabase user and deletes that
user plus its cascaded Bellwire data in `finally`:

```bash
BELLWIRE_API_URL=https://bellwire-self-host.example.workers.dev \
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY \
  npm run test:live < /secure/path/supabase-secret-key.txt
```

Finally, verify the physical-device path:

1. Build and install the app on a physical device.
2. Sign in with Apple and allow notifications.
3. Confirm the device appears in Settings.
4. Generate a binding code and bind the Bellwire Skill.
5. Create a Private project and complete a Direct v2 connection, then send a
   content-free test wake and verify on-device enrichment.
6. Create an explicitly approved Hosted project, schema, notification Surface,
   and ingest token.
7. Send a test Hosted Event and inspect its Delivery status.
8. On Pro, add the Bellwire Widget and start a Surface Live Activity from the
   project detail screen.
9. Treat `accepted_by_apns` as provider acceptance; separately confirm that the
   notification appeared on the device.

The configuration generator and doctor remove the need to edit Swift or
TypeScript source code. Cloud resource creation and Apple Developer setup are
still explicit steps because they affect billable resources, signing identity,
and external account state.
