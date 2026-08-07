// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const templatesRoot = join(repositoryRoot, "examples/templates");
const cli = join(repositoryRoot, "skills/bellwire/scripts/bellwire.mjs");

describe("public integration examples", () => {
  it("ships valid typed Surface templates", () => {
    const surfaceFiles = readdirSync(templatesRoot)
      .filter((name) => name.endsWith(".surface.json"))
      .sort();
    expect(surfaceFiles.length).toBeGreaterThan(0);
    for (const surfaceFile of surfaceFiles) {
      const validation = spawnSync(
        process.execPath,
        [cli, "validate-surface", "--file", join(templatesRoot, surfaceFile), "--json"],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(validation.status, validation.stderr).toBe(0);
    }
  });

  it("ships valid Event Specs with matching synthetic payloads", () => {
    const specFiles = readdirSync(templatesRoot)
      .filter((name) => name.endsWith(".event-spec.json"))
      .sort();
    expect(specFiles).toHaveLength(4);

    for (const specFile of specFiles) {
      const validation = spawnSync(
        process.execPath,
        [cli, "validate-spec", "--file", join(templatesRoot, specFile), "--json"],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(validation.status, validation.stderr).toBe(0);

      const spec = JSON.parse(readFileSync(join(templatesRoot, specFile), "utf8"));
      const eventFile = specFile.replace(".event-spec.json", ".event.json");
      const event = JSON.parse(readFileSync(join(templatesRoot, eventFile), "utf8"));
      expect(event.type).toBe(spec.eventType);
      expect(Object.keys(event.data).sort()).toEqual(Object.keys(spec.fields).sort());
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
  });

  it("keeps executable examples syntactically valid and free of token-shaped values", () => {
    const nodeExample = join(repositoryRoot, "examples/node/send-event.mjs");
    const shellExample = join(repositoryRoot, "examples/shell/send-event.sh");
    expect(spawnSync(process.execPath, ["--check", nodeExample]).status).toBe(0);
    expect(spawnSync("bash", ["-n", shellExample]).status).toBe(0);

    const publicSources = [
      readFileSync(nodeExample, "utf8"),
      readFileSync(shellExample, "utf8"),
      ...readdirSync(templatesRoot).map((name) => readFileSync(join(templatesRoot, name), "utf8")),
    ].join("\n");
    expect(publicSources).not.toMatch(/bw_(?:agent|live|ingest)_[A-Za-z0-9_-]{12,}/u);
  });

  it("encrypts a direct connection manifest for only the target device", () => {
    const deviceKeyId = "11111111-1111-4111-8111-111111111111";
    const device = createECDH("prime256v1");
    const publicKey = device.generateKeys();
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "encrypt-direct-connection",
        "--device-key-id",
        deviceKeyId,
        "--agreement-public-key",
        publicKey.toString("base64"),
        "--file",
        join(templatesRoot, "direct-connection.manifest.json"),
        "--json",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout);
    const sharedSecret = device.computeSecret(
      Buffer.from(envelope.ephemeralPublicKey, "base64"),
    );
    const key = Buffer.from(hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(deviceKeyId),
      Buffer.from("bellwire-direct-connection-v2"),
      32,
    ));
    const combined = Buffer.from(envelope.sealedBox, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, combined.subarray(0, 12));
    decipher.setAuthTag(combined.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(combined.subarray(12, -16)),
      decipher.final(),
    ]);
    expect(JSON.parse(plaintext.toString("utf8"))).toMatchObject({
      version: 2,
      connectionId: "videosays-device-connection",
    });
    expect(envelope).toMatchObject({
      projectId: "11111111-1111-4111-8111-111111111112",
      manifestVersion: 2,
    });
    expect(result.stdout).not.toContain("videosays.com");
  });
});
