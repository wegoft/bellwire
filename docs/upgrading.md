<!-- SPDX-License-Identifier: Apache-2.0 -->

# Upgrading Bellwire

Bellwire has four independent version axes:

- repository releases follow Semantic Versioning, currently `0.2.0`;
- the native App Store marketing version remains independently versioned;
- HTTP routes use the `/v1` compatibility namespace;
- D1 schemas advance through ordered migration files in `d1/auth` and
  `d1/business`.

A repository release does not imply an App Store submission, an API namespace
change, or a migration reset.

## Before upgrading

1. Read `CHANGELOG.md` and compare local configuration with the checked-in
   `.example` and development TOML files.
2. Export or copy both Auth and business D1 databases using Cloudflare's current
   backup/export facilities, and record the deployed Auth and API Worker version
   IDs.
3. Run `npm ci`, `npm run migrations:check`, `npm test`, and `npm run build`.
4. For the iOS fork, run `npm run ios:test:unit` and `npm run ios:build`.
5. Run `npm run self-host:doctor` before any remote change.

## Upgrade order

1. Apply Auth D1 migrations.
2. Deploy the Auth Worker and verify `/health` plus the ES256 JWKS.
3. Apply business D1 migrations.
4. Deploy the API Worker and verify `/health` and the unauthenticated `401`
   boundary.
5. Run `npm run self-host:doctor -- --online` and complete a device acceptance
   check before distributing a new iOS build.

Migrations are forward-only. The automated guard rejects destructive SQL unless
the migration contains `bellwire-migration: destructive-reviewed`, but that
annotation records review rather than making the operation reversible. Worker
code can roll back to a recorded version; migrated data cannot be rolled back by
the deployment workflow.

## Compatibility and recovery

Use expand/contract changes: add compatible columns or records first, deploy
readers and writers that tolerate both shapes, backfill, then remove obsolete
data only in a separately reviewed release. If Worker verification fails after
a migration, roll back Worker code only when it remains compatible with the new
schema. Otherwise deploy a forward fix.

Test D1 restoration in a separate database before treating a backup as usable.
Rotate Worker, APNs, Apple, Agent, and Ingest credentials if an upgrade exposes
them. Never copy production secrets into local development configuration.
