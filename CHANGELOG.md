<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to Bellwire are documented here. The project follows
[Semantic Versioning](https://semver.org/) for public repository releases.

## [Unreleased]

### Changed

- Replace the Supabase runtime with an isolated Better Auth Worker, Auth D1,
  business D1 repository, service binding, and ES256 access tokens.
- Add replay-safe Supabase snapshot conversion, migration ledgers,
  reconciliation gates, two-Worker self-hosting configuration, and a staged
  production cutover runbook.
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
- Skill, CLI, protocol references, examples, and public documentation under
  `Apache-2.0`.
- Bellwire name, app icon, and official service identifiers reserved under the
  trademark policy.

[Unreleased]: https://github.com/xwchris/bellwire/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xwchris/bellwire/releases/tag/v0.1.0
