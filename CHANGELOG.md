<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to Bellwire are documented here. The project follows
[Semantic Versioning](https://semver.org/) for public repository releases.

## [Unreleased]

## [0.2.0] - 2026-08-08

### Added

- Add an explicit hosted/self-hosted entitlement contract so self-hosted
  deployments keep export and Live Activity features without App Store billing.
- Add required self-hosted app-name, app-icon, support, and legal configuration,
  with bootstrap and doctor validation that keeps Bellwire brand assets out of
  redistributed forks.
- Add a one-command local API/Auth development stack, real iOS entitlement unit
  tests, machine-readable OpenAPI, telemetry, upgrade, and security operations
  documentation.
- Add DCO enforcement, migration safety checks, release metadata validation,
  third-party notices, and a CycloneDX npm SBOM release artifact.

### Changed

- Pin GitHub Actions to full commit SHAs and scope Cloudflare deployment
  credentials to only the steps that require them.
- Make D1 rollback policy explicitly forward-only and keep Worker code rollback
  separate from schema migration recovery.
- Move compact iOS text tokens to semantic Dynamic Type styles and make support,
  legal, product, display-name, and keychain identifiers deployment-aware.
- Generate six-digit pairing codes with rejection sampling to avoid modulo bias.

## [0.1.3] - 2026-08-08

### Fixed

- Align the self-contained Agent Skill and CLI with ClawHub's mandatory
  `MIT-0` Skill license while preserving the repository's AGPL, MPL, and Apache
  boundaries for the Worker, iOS app, standalone examples, and documentation.

## [0.1.2] - 2026-08-08

### Fixed

- Declare the Agent Skill's Apache-2.0 license in its frontmatter so public
  registries display the same license shipped in the Skill package.

## [0.1.1] - 2026-08-08

### Changed

- Make the published Agent Skill self-contained with bundled Direct v2
  templates, Node and Cloudflare reference adapters, D1 schemas, and the full
  Apache 2.0 license.
- Require secret-returning CLI commands to write one-time Tokens to a new
  `0600` file instead of stdout, and document the non-printing import flow.
- Share protocol validation between the CLI and Direct conformance checker,
  validate typed Private Surfaces and uniform authentication failures, and add
  release-contract and negative-parity tests.
- Replace the Supabase runtime with an isolated Better Auth Worker, Auth D1,
  business D1 repository, service binding, and ES256 access tokens.
- Remove the retired provider schema and one-time cutover tooling after the
  production migration completed.
- Move the iOS sign-in, refresh, revoke, and stale-session recovery flow to the
  Bellwire Auth Worker.
- Present Bellwire Pro as an adaptive large purchase sheet with a clearer
  Private-free / Hosted-Pro explanation and localized StoreKit pricing.
- Refine the native iOS information hierarchy with flatter list groups,
  collapsible technical details, clearer project actions, and standard
  destructive-action confirmations.
- Add a black-box Direct v2 conformance test for signed requests, endpoint
  coverage, replay protection, stale timestamps, unknown keys, and tampering.

### Fixed

- Show Pro content immediately while StoreKit products load instead of leaving
  the paywall visually empty on slow App Store connections.
- Keep remote project logos available through a bounded HTTPS disk cache, and
  distinguish an unavailable App Store region from a temporary StoreKit error.
- Keep the newest verified Apple entitlement across multiple transaction
  chains, avoid duplicate background purchase analytics, and make atomic
  monthly usage increments unambiguous in PostgreSQL.
- Reject oversized authenticated test Event and Private wake request bodies.

## [0.1.0] - 2026-07-23

### Added

- Cloudflare Worker API for projects, devices, typed events, notification
  Surfaces, live Surfaces, delivery state, and scoped Agent/Ingest tokens.
- Supabase-backed authentication, durable storage, migrations, and account
  deletion with Sign in with Apple token revocation.
- Native iOS 17 SwiftUI app with Sign in with Apple, APNs registration, inbox,
  project cards, event history, deep links, localization, and appearance
  controls.
- Bellwire Agent Skill and dependency-free CLI for connecting repositories.
- Hosted quick start, complete self-hosting guide, bootstrap/doctor/APNs
  preflight tools, integration examples, and architecture decisions.
- CI, CodeQL, Dependabot, issue templates, contribution guidance, security
  reporting, and automated license-boundary checks.

### Licensing

- Worker, Supabase, and operational tooling under `AGPL-3.0-only`.
- Native iOS app under `MPL-2.0`.
- Agent Skill, its CLI, and bundled references/examples under `MIT-0`.
- Standalone examples and public documentation under `Apache-2.0`.
- Bellwire name, app icon, and official service identifiers reserved under the
  trademark policy.

[Unreleased]: https://github.com/wegoft/bellwire/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/wegoft/bellwire/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/wegoft/bellwire/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/wegoft/bellwire/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/wegoft/bellwire/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wegoft/bellwire/releases/tag/v0.1.0
