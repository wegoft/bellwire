# Bellwire mascot state previews

Status: `V1.1 STATE PREVIEW`

These raster previews make the character states visibly distinguishable while the editable vector model sheet remains `SETUP_REQUIRED`. Every state was generated with the built-in image generation tool from `../mascot-signal-bird-master.png` as the sole identity anchor, then converted from a flat green background to alpha with the shared chroma-key helper.

`mascot-state-sheet.png` is the dark-background comparison sheet used for visual review.

## State mapping

| State | Source | Transparent master | iOS asset |
| --- | --- | --- | --- |
| Listening | `mascot-listening-chroma-source.png` | `mascot-listening-master.png` | `MascotListening` |
| Connecting / Testing | `mascot-connecting-chroma-source.png` | `mascot-connecting-master.png` | `MascotConnecting` |
| Accepted / Awaiting approval | `mascot-accepted-chroma-source.png` | `mascot-accepted-master.png` | `MascotAccepted` |
| Verified / Recovered | `mascot-verified-chroma-source.png` | `mascot-verified-master.png` | `MascotVerified` |
| Issue | `mascot-issue-chroma-source.png` | `mascot-issue-master.png` | `MascotIssue` |

Idle and All Quiet intentionally continue to use the original `MascotSignalBird` asset.

## Shared generation prompt

```text
Use case: identity-preserve
Asset type: Bellwire iOS mascot state asset
Input images: Image 1 is the sole character identity and style anchor.
Preserve exactly the same original Bellwire crested signal bird identity, body
proportions, long slim slightly down-curved graphite beak, amber and cream palette,
fixed graphite-and-cream wing pattern, glossy black eye design, matte editorial
texture, and anatomy. One full-body bird only, centered with generous clear padding,
no crop, right-facing three-quarter view, feet fully visible and grounded.
EXACTLY THREE rounded leaf-shaped crest feathers, all three separately visible with
clear negative space: one long primary crest, one medium crest at 80-85% of the
primary length, one short low crest at 60-70%. Keep the same wing markings as Image 1.
Scene/backdrop: perfectly flat uniform solid #00ff00 chroma-key background with no
shadows, gradients, texture, reflections, floor plane, or lighting variation. Crisp
silhouette; do not use #00ff00 in the bird. No cast shadow, contact shadow, text,
watermark, or extra elements.
Avoid: redesigned character; two or four crest feathers; merged or hidden crest;
changed wing pattern; floating circles, dots, rings, cables, signal trails, envelopes,
cards, parcels, bell, crown, clothing, speech bubble, eyebrows, blush, hands,
photorealistic feathers, plush toy, clay, plastic, glossy 3D, neon colors, confetti.
```

## State deltas

```text
Listening: turn the head slightly toward the viewer and tilt it with quiet curiosity;
angle the body subtly forward; fan the crest slightly forward. Observant, reliable,
gentle, never theatrical.

Connecting: lean forward from the feet, extend the neck toward the next step, keep
both wings closed, and sweep the three crest feathers subtly backward. Focused and
active, not successful or celebratory.

Accepted: stand tall and alert with head level, eye forward, chest slightly lifted,
and the crest in a neat attentive fan. Calmly waiting for the next confirmation;
absolutely no celebration.

Verified: make one small calm confirmation gesture with a gentle head nod, settled
chest, and one wing lifted only slightly while preserving its fixed pattern. Quietly
satisfied, not cheering or jumping.

Issue: lower the head toward the problem area, keep the eye attentive, draw the crest
slightly closer, and shift weight back. Careful concern and readiness to help, never
sadness, blame, panic, or cuteness.
```

The state pose is never the only status signal. Product copy must still name the verified fact, and `Accepted` must never be presented as device delivery.
