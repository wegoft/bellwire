# Bellwire Private-first quick start

This path uses the official Bellwire API and an already installed official iOS
build. It does not require a Cloudflare or Apple Developer account.

## See the complete product loop

1. Open Bellwire, sign in with Apple, and allow notifications.
2. On the empty home screen, choose **Try a Hosted demo**.
3. Confirm that the Bellwire Demo project shows revenue, production-service
   health, and monthly-goal live Surfaces plus payment, recovery, and deployment
   Events.
4. Open the Event detail to inspect delivery state. Provider acceptance and
   visible device presentation are separate checks.

The demo is an explicitly **Hosted** sample. Bellwire Cloud stores its sample
Events, Surfaces, and delivery state so the complete product loop works without
an external Agent. It does not claim Private delivery. The demo is idempotent
for an account: running it again reuses the existing project, three Events, and
three Surfaces instead of creating duplicates. If the demo is created before
the iPhone finishes APNs registration, Bellwire queues the deployment Event
once the enabled device registers, avoiding three sample notifications at once.

## Connect an Agent

1. In Bellwire Settings, choose **Generate binding code**.
2. Choose a temporary directory outside the repository, then exchange the
   single-use six-digit code without printing the returned Agent Token:

   ```bash
   bellwire_secret_dir="$(mktemp -d)"
   node skills/bellwire/scripts/bellwire.mjs bind \
     --code 123456 \
     --name "Codex on Mac" \
     --secret-output "$bellwire_secret_dir/agent-token" \
     --json
   ```

3. Import the `0600` token file into your password manager or local secret store
   without printing it, then expose it only to the current shell:

   ```bash
   export BELLWIRE_AGENT_TOKEN="$(<"$bellwire_secret_dir/agent-token")"
   ```

   Remove that exact temporary token file after the approved secret store has
   accepted it.

4. Confirm the connection and create a real project. New projects are Private:

   ```bash
   node skills/bellwire/scripts/bellwire.mjs list-projects
   node skills/bellwire/scripts/bellwire.mjs create-project \
     --name "My Agent" \
     --category automation \
     --json
   ```

The Agent token manages projects and configuration. For a production Private
integration, the Agent must:

1. implement signed Direct v2 notification, Inbox, and Surface endpoints in
   your service;
2. store device public keys, atomically consumed nonces, and short-lived opaque
   references in your database;
3. publish one encrypted manifest per iPhone and wait for readiness;
4. create a wake-only token and store it in your service's secret manager;
5. send an opaque wake only after the business transaction and outbox record
   commit;
6. run the Direct conformance checker and one real end-to-end operation.

Continue with the [Private examples](../examples/README.md) and
[Direct v2 reference](../skills/bellwire/references/direct-connections.md).

If you explicitly want Bellwire Cloud to store Event, Inbox, Surface, and
detailed notification content, ask the Agent to request Hosted mode. Approve
the request in the iOS app before creating an Ingest token.

## Self-hosted API

Set `BELLWIRE_API_URL` before running the same CLI commands:

```bash
export BELLWIRE_API_URL='https://your-worker.example.workers.dev'
```

The App itself must also be compiled against those Workers, D1 databases, and
your Apple signing identity. Follow the [self-hosting guide](self-hosting.md).
