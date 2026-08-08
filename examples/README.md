# Bellwire integration examples

New projects use Private delivery. Private notification, Inbox, and Surface
content stays in the source service and on the iPhone; Bellwire receives only a
random opaque wake reference. Hosted examples are available when the user has
approved Hosted mode in the App.

## Private reference implementations

- [Node.js Direct v2](../skills/bellwire/assets/examples/node/private-direct.mjs): signed endpoint handler,
  database callback boundaries, outbox record, and bounded wake sender.
- [Cloudflare Worker Direct v2](../skills/bellwire/assets/examples/cloudflare-worker/bellwire-direct.ts): D1-backed
  atomic nonce consumption plus notification, Inbox, and Surface routes.
- [D1 outbox schema](../skills/bellwire/assets/examples/cloudflare-worker/bellwire-private-outbox.sql): opaque
  24-hour detail storage owned by the user's service.

Create a wake-only token with `create-wake-token`, keep it in
`BELLWIRE_WAKE_TOKEN`, publish a manifest v2, and run
`skills/bellwire/scripts/conformance-direct.mjs` before production verification.

## Hosted examples

These examples send typed Events after the source operation has succeeded. They
use three runtime values that must stay outside Git:

- `BELLWIRE_INGEST_TOKEN`: the project-scoped `bw_live_...` token.
- `BELLWIRE_PROJECT_ID`: the destination project ID.
- `BELLWIRE_API_URL`: optional; defaults to `https://api.bellwire.app`.

## Configure a Hosted Event type

After binding the CLI with an Agent token, create a schema from one of the
templates:

```bash
bellwire_secret_dir="$(mktemp -d)"
node skills/bellwire/scripts/bellwire.mjs create-schema \
  --project "$BELLWIRE_PROJECT_ID" \
  --file examples/templates/deployment.failed.event-spec.json

node skills/bellwire/scripts/bellwire.mjs create-token \
  --project "$BELLWIRE_PROJECT_ID" \
  --name production \
  --secret-output "$bellwire_secret_dir/ingest-token" \
  --json
```

Import the `0600` file into the source application's secret manager without
printing it. The Token is created only once and is never written to stdout.

## Choose an adapter

- [Node.js](node/send-event.mjs): dependency-free Node 22 script that reads a
  JSON Event file.
- [Shell](shell/send-event.sh): curl adapter suitable for deployment scripts.
- [Cloudflare Worker](cloudflare-worker/bellwire.ts): reusable function with a
  bounded timeout; store the token with `wrangler secret put`.
- [GitHub Actions](github-actions/deployment-failed.yml): failure notification
  using an Actions secret and repository variable.

Example Node invocation:

```bash
BELLWIRE_PROJECT_ID='project-id' \
BELLWIRE_INGEST_TOKEN='bw_live_REPLACE_ME' \
  node examples/node/send-event.mjs \
  examples/templates/deployment.failed.event.json \
  'deploy-run-123-failed'
```

Every retry of the same source operation and event kind must reuse the same
idempotency key. Do not substitute a random UUID for a durable business, task,
deployment, or workflow-run identifier.

## Scenario templates

- `payment.success`: records a completed payment without exposing the
  sensitive customer reference in the notification.
- `deployment.failed`: records the environment, revision, and safe diagnostic
  URL for a failed release.
- `agent.waiting`: records a task that needs a human decision.

Each scenario has an `.event-spec.json` file for configuration and a matching
synthetic `.event.json` payload for testing. Replace sample values before using
the payload in production, and never send credentials or unrestricted logs.
