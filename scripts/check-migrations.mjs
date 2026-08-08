#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const migrationRoots = ["d1/auth", "d1/business"];
const destructivePatterns = [
  /\bDROP\s+(?:TABLE|INDEX|TRIGGER|COLUMN)\b/iu,
  /\bALTER\s+TABLE\b[\s\S]*?\b(?:DROP|RENAME)\b/iu,
  /\bTRUNCATE\b/iu,
  /\bDELETE\s+FROM\b/iu,
];
const override = "bellwire-migration: destructive-reviewed";
const failures = [];

for (const root of migrationRoots) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const file = path.join(root, entry.name);
    const source = await readFile(file, "utf8");
    if (source.includes(override)) continue;
    if (destructivePatterns.some((pattern) => pattern.test(source))) {
      failures.push(file);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Destructive D1 migration statements require an expand/contract review marker (${override}):\n`,
  );
  for (const file of failures) process.stderr.write(`- ${file}\n`);
  process.exit(1);
}

process.stdout.write("D1 migrations satisfy the forward-compatible policy.\n");
