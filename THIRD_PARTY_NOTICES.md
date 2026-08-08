<!-- SPDX-License-Identifier: Apache-2.0 -->

# Third-party notices

Bellwire includes or depends on third-party software. Each component remains
subject to its own license; Bellwire's repository licenses do not replace those
terms.

## Bundled material

### SwiftUI-Agent-Skill

- Project: `SwiftUI-Agent-Skill`
- Copyright: Copyright (c) 2026 Paul Hudson
- License: MIT
- Source revision used here: `be297e146e9080167780afabeee896873c6fc1c5`
- Bundled path: `.agents/skills/swiftui-pro/**`
- License text: [`.agents/skills/swiftui-pro/LICENSE`](.agents/skills/swiftui-pro/LICENSE)

The bundled skill is development guidance and is not linked into the Bellwire
iOS application binary.

## Package dependencies

JavaScript production and development dependencies, resolved versions,
integrity hashes, and declared license metadata are recorded in
`package-lock.json`. Each GitHub release also includes a CycloneDX npm SBOM.
Run the following against a checkout to produce the same machine-readable
inventory:

```bash
npm ci
npm sbom --sbom-format=cyclonedx
```
