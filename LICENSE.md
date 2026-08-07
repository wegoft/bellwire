# Bellwire licensing

Bellwire uses multiple open-source licenses. The license for a file is
determined by its path below. SPDX identifiers are authoritative shorthand;
the complete license texts are in [`LICENSES/`](LICENSES/).

The root [`LICENSE`](LICENSE) contains the exact AGPL-3.0 text so GitHub can
identify the repository's default license. The component exceptions in this
map remain controlling for their paths.

Copyright © 2026 Bellwire contributors.

| Component | Paths | SPDX license |
| --- | --- | --- |
| Worker APIs, delivery services, D1 and legacy Supabase schemas, and operational tooling | `src/**`, `d1/**`, `supabase/**`, `scripts/**`, JavaScript/TypeScript tests, and root runtime/build configuration unless listed below | `AGPL-3.0-only` |
| Native iOS app | `ios/**` and `test/*.swift` | `MPL-2.0` |
| Agent Skill, CLI, protocol references, examples and public documentation | `skills/**`, `examples/**`, public `docs/**`, `.github/**`, and the root community/documentation files listed below | `Apache-2.0` |
| Bellwire app icon artwork and other Bellwire brand assets | `ios/Bellwire/Bellwire/Assets.xcassets/AppIcon.appiconset/BellwireIcon.png`, `ios/Bellwire/Design/AppIcon.svg`, and assets identified in `TRADEMARK.md` | No open-source trademark or artwork license |

The Apache-2.0 root files are `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
`SECURITY.md`, `CODE_OF_CONDUCT.md`, `TRADEMARK.md`, and this license map.
Files inside the ignored `docs/private/**` directory are not part of the public
distribution and are not licensed by this repository.

Directory notices repeat these boundaries near the relevant code. Source files
that support comments carry SPDX headers; this map covers generated, binary,
configuration, and data files that cannot safely carry a header. If a file is
not covered by an explicit exception, the repository default is
`AGPL-3.0-only`.

## License texts

- [GNU Affero General Public License v3.0 only](LICENSES/AGPL-3.0-only.txt)
- [Mozilla Public License 2.0](LICENSES/MPL-2.0.txt)
- [Apache License 2.0](LICENSES/Apache-2.0.txt)

## Contributions

Contributions are accepted under the license assigned to the component being
changed. Moving code between components with different licenses requires
maintainer review. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Trademarks and third-party material

These software licenses do not grant permission to use the Bellwire name,
logo, app icon, official domains, or other source identifiers except as
described in [TRADEMARK.md](TRADEMARK.md). In particular, the Bellwire app icon
files remain brand assets and are excluded from the open-source license grants.

Third-party dependencies and bundled third-party material remain subject to
their own license terms. No license in this repository grants rights that the
copyright holders do not have.
