#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from "node:child_process";
import process from "node:process";

const smoke = process.argv.slice(2).includes("--smoke");
const children = [];

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stopChildren();
    process.exit(0);
  });
}

try {
  await run("npx", [
    "wrangler", "d1", "migrations", "apply", "DB", "--local", "-c", "wrangler.dev.toml",
  ]);
  await run("npx", [
    "wrangler", "d1", "migrations", "apply", "AUTH_DB", "--local",
    "-c", "wrangler.auth.dev.toml",
  ]);

  children.push(start("API", [
    "wrangler", "dev", "-c", "wrangler.dev.toml",
    "--inspector-port", "9230", "--show-interactive-dev-session", "false",
  ]));
  children.push(start("Auth", [
    "wrangler", "dev", "-c", "wrangler.auth.dev.toml",
    "--inspector-port", "9231", "--show-interactive-dev-session", "false",
  ]));

  const [api, auth] = await Promise.all([
    waitForJSON("http://127.0.0.1:8787/health", (body) =>
      body?.status === "ok" && body?.service === "bellwire-api"),
    waitForJSON("http://127.0.0.1:8788/health", (body) =>
      body?.ok === true && body?.service === "bellwire-auth"),
  ]);
  process.stdout.write(`Bellwire local stack ready: ${api.service}, ${auth.service}\n`);

  if (smoke) {
    await stopChildren();
  } else {
    process.stdout.write("API  http://127.0.0.1:8787\nAuth http://127.0.0.1:8788\n");
    await Promise.race(children.map(({ process: child }) => new Promise((resolve) => {
      child.once("exit", resolve);
    })));
    throw new Error("A local Worker exited unexpectedly");
  }
} catch (error) {
  await stopChildren();
  process.stderr.write(`Bellwire local stack: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function start(label, args) {
  const child = spawn("npx", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  return { label, process: child };
}

async function waitForJSON(url, validate) {
  let lastError = "not reachable";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && validate(body)) return body;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become healthy: ${lastError}`);
}

async function stopChildren() {
  const running = children.splice(0);
  await Promise.all(running.map(({ process: child }) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  })));
}
