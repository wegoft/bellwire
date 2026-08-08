// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateDirectSurfacesResponse,
  validateEventSpec,
  validateSurfaceInput,
} from "../skills/bellwire/scripts/protocol-validation.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const skillRoot = join(repositoryRoot, "skills/bellwire");
const cli = join(skillRoot, "scripts/bellwire.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("published Bellwire Skill contract", () => {
  it("is self-contained and keeps long references navigable", () => {
    expect(existsSync(join(skillRoot, "README.md"))).toBe(false);
    const markdownFiles = filesBelow(skillRoot).filter((path) => path.endsWith(".md"));
    for (const file of markdownFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const href = match[1];
        if (/^(?:https?:|mailto:|#)/u.test(href)) continue;
        const target = resolve(dirname(file), href.split("#", 1)[0]);
        expect(relative(skillRoot, target).startsWith(".."), `${file} links outside the release archive`).toBe(false);
        expect(existsSync(target), `${file} has a broken link to ${href}`).toBe(true);
      }
      if (relative(join(skillRoot, "references"), file).startsWith("..") === false
          && source.split("\n").length > 100) {
        expect(source, `${file} must include a linked table of contents`).toMatch(/^- \[[^\]]+\]\(#[^)]+\)$/mu);
      }
    }
  });

  it("stores one-time tokens in a new 0600 file without printing them", async () => {
    const token = "bw_agent_contract_test_secret_123456789";
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "agent-1",
        name: "Contract test",
        scopes: ["project:write"],
        token,
        createdAt: "2026-08-08T00:00:00.000Z",
      }));
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const directory = mkdtempSync(join(tmpdir(), "bellwire-skill-secret-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "agent-token");
    try {
      const result = await runCli([
        "bind", "--code", "123456", "--name", "Contract test",
        "--secret-output", secretPath, "--json",
      ], { BELLWIRE_API_URL: `http://127.0.0.1:${address.port}` });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
      expect(JSON.parse(result.stdout)).toMatchObject({ secretStoredAt: secretPath });
      expect(readFileSync(secretPath, "utf8")).toBe(`${token}\n`);
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
      expect(requests).toBe(1);
    } finally {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });

  it("refuses to consume a one-time token response without a secret destination", async () => {
    const result = await runCli(["bind", "--code", "123456", "--json"], {
      BELLWIRE_API_URL: "http://127.0.0.1:1",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--secret-output is required");
    expect(result.stdout).toBe("");
  });

  it("keeps local validation aligned with API and iOS limits", () => {
    expect(() => validateEventSpec({
      eventType: "payment.success",
      fields: { amount: { type: "number" } },
      notification: { title: "Payment", body: "{{ amount }}", subtitle: "x".repeat(241) },
    })).toThrow(/subtitle.*240/u);

    expect(() => validateSurfaceInput({
      type: "stats",
      title: "Revenue",
      metrics: [{ label: "Today", value: "x".repeat(65) }],
    })).toThrow(/value.*64/u);

    expect(() => validateSurfaceInput({
      type: "alert",
      title: "Deploy",
      message: "Needs attention",
      icon: { symbol: "invalid symbol" },
    })).toThrow(/SF Symbol/u);

    expect(() => validateDirectSurfacesResponse({
      surfaces: [{
        id: "surface-1",
        projectId: "22222222-2222-4222-8222-222222222222",
        surfaceKey: "revenue",
        type: "stats",
        title: "Revenue",
        content: { metrics: [{ label: "Today", value: "¥128" }] },
        displayOrder: 0,
        version: 1,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      }],
    }, "11111111-1111-4111-8111-111111111111")).toThrow(/projectId.*manifest/u);
  });
});

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function runCli(argumentsList, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, ...argumentsList], {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
