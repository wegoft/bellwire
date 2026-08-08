#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import process from "node:process";

const devices = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
  encoding: "utf8",
});
if (devices.status !== 0) {
  process.stderr.write(devices.stderr || "Unable to list iOS simulators\n");
  process.exit(1);
}

const runtimes = JSON.parse(devices.stdout).devices;
const iphone = Object.values(runtimes)
  .flat()
  .find((device) => device.isAvailable && device.name.startsWith("iPhone"));
if (!iphone) {
  process.stderr.write("No available iPhone simulator was found.\n");
  process.exit(1);
}

process.stdout.write(`Running BellwireTests on ${iphone.name} (${iphone.udid})\n`);
const result = spawnSync("xcodebuild", [
  "test",
  "-quiet",
  "-project", "ios/Bellwire/Bellwire.xcodeproj",
  "-scheme", "Bellwire",
  "-destination", `id=${iphone.udid}`,
  "-configuration", "Debug",
  "-enableCodeCoverage", "YES",
  "CODE_SIGNING_ALLOWED=NO",
], { stdio: "inherit" });
process.exit(result.status ?? 1);
