<!-- SPDX-License-Identifier: Apache-2.0 -->

# Governance

Bellwire uses maintainer-led governance while the project is in `0.x` releases.
The goal is predictable technical decisions with a clear path for community
participation.

## Decisions

- Routine fixes and documentation changes are accepted through review by a
  maintainer.
- API, protocol, storage, authentication, licensing, and default-delivery
  changes require an issue or architecture decision record before merge.
- Security fixes may be developed privately and disclosed after supported
  deployments can be updated.
- The project lead has final responsibility for release, trademark, hosted
  service, and incident decisions. Rationale should be recorded publicly when
  disclosure is safe.

## Contributions and releases

All non-bot commits require a Developer Certificate of Origin sign-off. Pull
requests must pass CI, CodeQL, DCO, license-boundary, migration, and relevant iOS
checks. Releases use Semantic Versioning for the repository distribution; the
iOS marketing version, API version, and D1 migration identifiers are separate
compatibility axes described in [the upgrading guide](docs/upgrading.md).

Maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md). Project conduct is
governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
