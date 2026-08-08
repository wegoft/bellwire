// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`Usage:
  DCO_BASE_SHA=<sha> DCO_HEAD_SHA=<sha> npm run dco:check
  npm run dco:check -- --base <sha> --head <sha>

Checks every non-bot commit in base..head for a Signed-off-by trailer.
`);
  process.exit(0);
}

const base = validateSha(options.base ?? process.env.DCO_BASE_SHA, "base SHA");
const head = validateSha(options.head ?? process.env.DCO_HEAD_SHA, "head SHA");
const commits = git(["rev-list", "--reverse", `${base}..${head}`])
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
let botCount = 0;
for (const commit of commits) {
  const [sha, authorName, authorEmail, message] = git([
    "show",
    "-s",
    "--format=%H%x00%an%x00%ae%x00%B",
    commit,
  ]).split("\0");
  if (isBot(authorName, authorEmail)) {
    botCount += 1;
    continue;
  }
  if (!/^Signed-off-by:\s+.+\s+<[^<>\s]+@[^<>\s]+>\s*$/imu.test(message)) {
    failures.push(`${sha.slice(0, 12)} ${message.split("\n")[0] || "(no subject)"}`);
  }
}

if (failures.length > 0) {
  process.stderr.write("The following commits are missing a valid Signed-off-by trailer:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.stderr.write("Amend each commit with `git commit --amend -s` and update the branch.\n");
  process.exit(1);
}

process.stdout.write(`✓ DCO sign-off verified for ${commits.length - botCount} commit(s)`);
if (botCount > 0) process.stdout.write(`; skipped ${botCount} bot commit(s)`);
process.stdout.write("\n");

function git(arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function validateSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{7,40}$/iu.test(value)) {
    throw new Error(`Missing or invalid ${label}`);
  }
  return value;
}

function isBot(name, email) {
  return name.endsWith("[bot]") || email.endsWith("[bot]@users.noreply.github.com");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      result.help = true;
      continue;
    }
    if (argument !== "--base" && argument !== "--head") {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}
