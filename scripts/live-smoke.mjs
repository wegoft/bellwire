#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

const apiURL = process.env.BELLWIRE_API_URL ?? "https://api.bellwire.app";
const accessToken = process.env.BELLWIRE_TEST_ACCESS_TOKEN?.trim();
if (!accessToken) {
  throw new Error("BELLWIRE_TEST_ACCESS_TOKEN must contain a disposable Bellwire Auth access token.");
}
if (process.env.BELLWIRE_TEST_ALLOW_ACCOUNT_DELETION !== "DELETE_DISPOSABLE_ACCOUNT") {
  throw new Error(
    "Set BELLWIRE_TEST_ALLOW_ACCOUNT_DELETION=DELETE_DISPOSABLE_ACCOUNT only for a disposable test account.",
  );
}
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const userHeaders = {
  authorization: `Bearer ${accessToken}`,
  "content-type": "application/json",
};

try {
  const health = await requestJSON(`${apiURL}/health`, {}, 200);
  assert(health.status === "ok", "Worker health check did not report ok");

  const project = await requestJSON(`${apiURL}/v1/projects`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "Live Smoke", category: "verification" }),
  }, 201);
  assert(typeof project.id === "string", "Project creation did not return an ID");

  const schema = await requestJSON(`${apiURL}/v1/projects/${project.id}/event-schemas`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({
      eventType: "build.completed",
      fields: {
        branch: { type: "string", required: true },
        duration: { type: "number", required: true },
        internalNote: { type: "string", sensitive: true },
      },
      notification: {
        title: "Build completed",
        body: "{{ branch }} in {{ duration }}s",
      },
    }),
  }, 201);
  assert(schema.eventType === "build.completed", "Schema creation returned an unexpected type");

  const surfaceURL = `${apiURL}/v1/projects/${project.id}/surfaces/smoke-build`;
  const firstSurface = await requestJSON(surfaceURL, {
    method: "PUT",
    headers: userHeaders,
    body: JSON.stringify({
      type: "stats",
      title: "Build status",
      subtitle: "Live smoke",
      metrics: [
        { label: "Branch", value: "main" },
        { label: "State", value: "Healthy", color: "green" },
      ],
    }),
  }, 200);
  assert(firstSurface.type === "stats" && firstSurface.version === 1, "Initial Surface upsert failed");

  const updatedSurface = await requestJSON(surfaceURL, {
    method: "PUT",
    headers: userHeaders,
    body: JSON.stringify({
      type: "progress",
      title: "Build progress",
      percentage: 72,
    }),
  }, 200);
  assert(updatedSurface.type === "progress" && updatedSurface.version === 2, "Stable Surface update failed");

  const surfaces = await requestJSON(
    `${apiURL}/v1/projects/${project.id}/surfaces`,
    { headers: userHeaders },
    200,
  );
  assert(
    surfaces.surfaces?.some((item) => item.surfaceKey === "smoke-build" && item.version === 2),
    "Updated Surface was not visible",
  );

  const ingest = await requestJSON(`${apiURL}/v1/projects/${project.id}/ingest-tokens`, {
    method: "POST",
    headers: userHeaders,
    body: JSON.stringify({ name: "smoke" }),
  }, 201);
  assert(typeof ingest.token === "string" && ingest.token.startsWith("bw_live_"), "Ingest token was not issued");

  const idempotencyKey = `smoke-${suffix}`;
  const eventPayload = JSON.stringify({
    type: "build.completed",
    data: { branch: "main", duration: 42, internalNote: "redacted" },
    occurredAt: new Date().toISOString(),
  });
  const event = await requestJSON(`${apiURL}/v1/events/${project.id}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ingest.token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: eventPayload,
  }, 201);
  const duplicate = await requestJSON(`${apiURL}/v1/events/${project.id}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ingest.token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: eventPayload,
  }, 200);
  assert(duplicate.deduplicated === true && duplicate.eventId === event.eventId, "Idempotency check failed");

  const inbox = await requestJSON(`${apiURL}/v1/inbox?limit=10`, { headers: userHeaders }, 200);
  assert(inbox.events?.some((item) => item.id === event.eventId), "Event was not visible in the inbox");

  const detail = await requestJSON(`${apiURL}/v1/events/${event.eventId}`, { headers: userHeaders }, 200);
  assert(detail.sensitiveFields?.includes("internalNote"), "Sensitive field metadata was not preserved");
  await requestJSON(`${apiURL}/v1/events/${event.eventId}/read`, {
    method: "POST",
    headers: userHeaders,
  }, 200);

  const binding = await requestJSON(`${apiURL}/v1/device-bindings`, {
    method: "POST",
    headers: userHeaders,
  }, 201);
  const agent = await requestJSON(`${apiURL}/v1/device-bindings/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: binding.code, name: "Live Smoke Agent" }),
  }, 201);
  const agentProjects = await requestJSON(`${apiURL}/v1/projects`, {
    headers: { authorization: `Bearer ${agent.token}` },
  }, 200);
  assert(agentProjects.projects?.some((item) => item.id === project.id), "Agent binding could not read the project");

  const healthSummary = await requestJSON(
    `${apiURL}/v1/projects/${project.id}/delivery-health`,
    { headers: userHeaders },
    200,
  );
  assert(healthSummary.status === "idle", "Delivery health should be idle without a registered device");

  const devicePayload = JSON.stringify({
    name: "Smoke iPhone",
    apnsToken: "a".repeat(64),
    appVersion: "1.0",
  });
  const firstDevice = await requestJSON(`${apiURL}/v1/devices`, {
    method: "POST",
    headers: userHeaders,
    body: devicePayload,
  }, 201);
  const sameDevice = await requestJSON(`${apiURL}/v1/devices`, {
    method: "POST",
    headers: userHeaders,
    body: devicePayload,
  }, 201);
  assert(firstDevice.id === sameDevice.id, "Re-registering an APNs token changed its device ID");
  await requestJSON(`${apiURL}/v1/devices/${firstDevice.id}`, {
    method: "DELETE",
    headers: userHeaders,
  }, 204);
  await requestJSON(surfaceURL, {
    method: "DELETE",
    headers: userHeaders,
  }, 204);

  console.log(JSON.stringify({
    ok: true,
    worker: "healthy",
    bellwireAuthJwt: "verified",
    projectLifecycle: "verified",
    liveSurfaceUpsert: "verified",
    eventIdempotency: "verified",
    inboxAndDetail: "verified",
    agentBinding: "verified",
    deviceUpsert: "verified",
    deliveryWithoutDevice: "idle",
  }, null, 2));
} finally {
  await fetch(`${apiURL}/v1/account`, { method: "DELETE", headers: userHeaders });
}

async function requestJSON(url, init, expectedStatus) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${safeError(body)}`);
  }
  return body;
}

function safeError(body) {
  const candidate = body?.error?.message ?? body?.message ?? body?.msg ?? "Unexpected response";
  return String(candidate).slice(0, 240);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
