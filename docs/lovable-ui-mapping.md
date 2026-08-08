# Bellwire Lovable → Native iOS UI Mapping (historical)

> [!IMPORTANT]
> 本文保留旧 Lovable 到原生 iOS 的功能映射和业务逻辑边界。新的视觉主题、字体、Surface、吉祥物使用和逐屏布局以 [Bellwire UI 重构总纲](./brand/ui-redesign-blueprint.md) 为准；旧暖纸色与衬线视觉方向不再作为实现依据。

## Scope and source of truth

- Design reference (historical): the former `agent-whisper-sync` repository at commit `7ac14e8f46b9df97f4c6159e2571e3b73d4076e0`.
- Native app: [`../ios/Bellwire`](../ios/Bellwire).
- Functional source of truth: the existing Swift models, `AppModel`, `APIClient`, Keychain session, APNs delegate, deep-link handling, and server responses.
- Visual source of truth: Lovable `src/routes/index.tsx`, `src/styles.css`, and `src/routes/__root.tsx`.
- The Lovable phone frame, fake status bar/notch, showcase captions, fixed browser dimensions, hover behavior, and web backdrop implementation are explicitly excluded.

## 1. Lovable page inventory

| Lovable screen | Primary visual intent | Important states/components |
| --- | --- | --- |
| Welcome | Warm graphite editorial hero, amber Bellwire signal, three compact event previews, Apple CTA | Authentication in progress/error, compact-height layout |
| Notification onboarding | Permission priming with three event families | Enable, skip, permission failure/denied |
| Home | Date/greeting, digest strip, live surfaces, recent event feed | Loading, error/offline, empty, unread, running, failed |
| Projects | Connected-project list with status, latest event, unread/running affordance, filter | Loading, empty, error, active/running/paused |
| Project detail | Identity/status, 24h health, live surfaces, recent events, schemas, endpoint | Loading/error, pause/resume disabled, empty surfaces/events/schemas |
| Event detail | Schema label, editorial event title, structured fields, delivery timeline, technical fields, raw JSON | Loading/error, unread/read, masked/revealed, queued/accepted/failed |
| Settings | Account card, agent connection, permissions, devices, privacy, sign out, version | Permission unknown/denied/authorized, empty devices, errors |
| Binding code | Real expiring code, instruction snippet, copy actions | Loading/error, copied feedback, expiration |

## 2. Existing iOS page inventory

| Existing SwiftUI screen | File | Existing responsibility |
| --- | --- | --- |
| Root/auth gate | `RootView.swift` | Session gate, one-time notification onboarding, transition to main tabs |
| Welcome | `OnboardingViews.swift` | Real Sign in with Apple request/nonce and authentication completion |
| Notification onboarding | `OnboardingViews.swift` | Existing `UNUserNotificationCenter` permission request and skip state |
| Home/inbox | `InboxViews.swift` | Dashboard refresh, live surfaces, projects, recent events, deep-link routing |
| Project detail | `DetailViews.swift` | Project overview/events fetch, pause/resume, health, schemas, endpoint copy |
| Event detail | `DetailViews.swift` | Detail fetch, mark-read, masking/reveal, deliveries, redacted JSON |
| Settings/binding | `SettingsView.swift` | Binding generation, permissions, iOS Settings, devices, account/sign-out |
| Live surface renderer | `SurfaceViews.swift` | Stats, metrics, progress, segmented progress, alert, timer, outbound action |

The existing tab bar exposes only Home and Settings. Projects currently appear as a horizontal section inside Home; Events are the Home feed.

## 3. Page mapping

| Lovable destination | Native destination | Mapping decision |
| --- | --- | --- |
| Welcome | `WelcomeView` | Restyle only; keep the real Apple auth button callbacks and error handling |
| Notification onboarding | `NotificationOnboardingView` | Restyle only; keep the existing permission request and completion binding |
| Home | `InboxView` / renamed visual role | Preserve dashboard data, but reorganize as greeting → digest → live surfaces → recent events |
| Projects | New `ProjectsView` using `AppModel.projects/events/liveSurfaces` | Add a real independent tab without adding APIs or mock records |
| Project detail | `ProjectDetailView` | Restyle and reorganize existing response fields/actions |
| Event detail | `EventDetailView` | Restyle; preserve masking and mark-read behavior; add native ShareLink/copy actions |
| Settings | `SettingsView` | Restyle and expose existing binding/permission/device/account actions |
| Binding code | `BindingCodeSheet` | Present the actual `BindingResponse`; never use the showcase value |
| Four-item web tab bar | Native `TabView` | Home, Projects, Events, Settings; Home and Events may share the same fetched event collection but have separate native presentation |

## 4. Existing business-logic reuse points

- `AppModel.bootstrap()` remains the app bootstrap and notification status refresh entry point.
- `AppModel.completeAppleAuthorization` remains the only Apple login completion path; its nonce, Bellwire Auth exchange, Keychain persistence, dashboard load, and device registration remain unchanged.
- `AppModel.loadDashboard` remains the single dashboard source for projects, live surfaces, inbox events, and devices.
- `AppModel.loadProject`, `setProjectPaused`, `loadEvent`, and `markRead` remain the project/event operations.
- `AppModel.createBinding` remains the only source for binding codes.
- `AppModel.requestNotificationPermission` and `refreshNotificationStatus` remain the notification paths.
- `PushDelegate`, `receivedAPNsToken`, and `handleDeepLink` remain untouched except for navigation presentation integration if required.
- `KeychainStore`, `APIClient`, DTOs, JSON decoding, and persisted onboarding/session values remain intact.

## 5. SwiftUI files to refactor

| File | Planned UI work |
| --- | --- |
| `Theme.swift` | Extend the existing theme into centralized colors, typography, spacing, radii, shadows, animation tokens, button/surface styles |
| `Components.swift` | Add reusable section header, avatar, status badge, buttons, settings/device/field/timeline primitives and stronger state components |
| `OnboardingViews.swift` | Rebuild Welcome and notification onboarding composition |
| `RootView.swift` | Expose the Lovable-inspired four-destination native tab structure |
| `InboxViews.swift` | Recompose Home, add Projects and Events list presentations, preserve shared navigation/data |
| `SurfaceViews.swift` | Align cards with amber/graphite surfaces and status-specific treatments |
| `DetailViews.swift` | Recompose Project and Event detail pages around reusable primitives |
| `SettingsView.swift` | Recompose account/connection/notifications/devices/legal/version and binding sheet |
| `BellwireApp.swift` | Apply the centralized tint/navigation appearance only if necessary |

No API, repository, persistence, auth, or notification service file needs a business-logic change.

## 6. Public components

- `BellwireMark` / `ProjectAvatarView` (implemented by evolving the current `ProjectGlyph`)
- `SectionHeaderView`
- `StatusBadgeView` (evolves `StatusLabel`)
- `EventRowView` (evolves `EventRow`)
- `DigestMetricView` and `MetricCardView`
- `LiveSurfaceCard` variants (existing type-driven renderer retained)
- `AlertCardView` through the existing alert surface renderer
- `SettingsRowView`
- `DeviceRowView`
- `StructuredFieldRow`
- `DeliveryTimelineView`
- `BindingCodeView`
- `PrimaryButton` and `SecondaryButton`
- `LoadingEventRows`, `EmptyState`, and `ErrorBanner` retained and visually aligned

Components are extracted only when used by multiple screens or when they encapsulate an accessibility/state behavior.

## 7. Color and font mapping

### Color roles

| Lovable CSS role | Native token | Native direction |
| --- | --- | --- |
| `--page` | `BellwireTheme.background` | Warm graphite in dark appearance; warm paper neutral in light appearance |
| `--surface` | `BellwireTheme.surface` | Primary cards/groups |
| `--surface-2` | `BellwireTheme.raisedSurface` | Nested icon and technical surfaces |
| `--surface-3` | new tertiary surface | Tracks, disabled badges, pressed/secondary controls |
| `--ink` | `BellwireTheme.ink` | Primary content |
| `--ink-dim` | `BellwireTheme.secondaryInk` | Supporting content |
| `--ink-mute` | new muted ink | Metadata and overlines |
| `--line` / `--line-strong` | separator tokens | Hairlines and technical outlines |
| `--signal` | `BellwireTheme.accent` | Warm amber primary signal |
| `--live` | new live token | Running/active state |
| `--ok`, `--warn`, `--danger` | semantic tokens | Accepted, queued/degraded, failed |

The native theme supports both appearances. Dark mode follows Lovable most closely; light mode uses the same warm hue family instead of forcing a dark-only app.

### Typography roles

| Lovable | Native mapping |
| --- | --- |
| Instrument Serif | New York via `.system(..., design: .serif)` for editorial display titles |
| Inter | SF Pro system text styles for body, buttons, lists, and accessibility scaling |
| JetBrains Mono | SF Mono via `.system(..., design: .monospaced)` for overlines, schema, IDs, endpoint, code, and dynamic technical values |

Dynamic metrics use monospaced digits. Text uses semantic styles or `@ScaledMetric`-compatible sizing so Dynamic Type can grow without clipping.

## 8. Web effect → native iOS conversion

| Web showcase behavior | Native implementation |
| --- | --- |
| `.phone-frame`, `.phone-notch`, `.status-bar` | Omitted; system window, status bar, and safe areas |
| Absolute simulated tab bar | Native `TabView` with system safe-area behavior |
| Browser page transitions | `NavigationStack`, native push transitions, sheets, and SwiftUI state transitions |
| CSS backdrop blur | Native tab/material only where it improves hierarchy; no browser emulation |
| CSS radial amber glow | SwiftUI gradient overlay clipped inside real page/card bounds |
| Web hover | Native press scale/opacity, haptics on important copy/status actions |
| Web buttons | Native `Button`, `SignInWithAppleButton`, `Link`, `ShareLink` |
| Fake back/Share labels | Navigation bar back behavior and native toolbar/ShareLink |
| Fixed device height | ScrollView/LazyVStack with safe area and compact-height tolerance |
| Horizontal raw code | Selectable native text with horizontal scrolling and a copy action |
| Web toggle | Status display plus real permission action/open Settings; no fake local toggle |
| Showcase Rotate endpoint | Hidden because no backend operation exists |

## 9. Risks and mitigations

1. **This document is historical.** Treat the current tracked Swift sources and tests as authoritative; do not infer implementation status from this original migration checklist.
2. **Projects have no dedicated unread/latest-event fields.** Derive badges/latest event from the already loaded `events` collection; do not fabricate values.
3. **Running status is not on `ProjectSummary`.** Derive a running affordance only from matching progress/segmented/timer live surfaces; otherwise show the real project status.
4. **Event schema version is not returned in `EventDetail`.** Do not invent a version. Show the event type; omit version or label it only where a real schema record can be matched.
5. **Rotate endpoint is unsupported.** Keep endpoint copy; do not surface an enabled Rotate control.
6. **Privacy/Terms URLs are deployment configuration.** Use `AppConfig` values generated through xcconfig; do not hard-code fork-specific legal endpoints in Swift.
7. **Offline is not separately modeled.** Existing connection errors are presented as actionable offline/error state while preserving loaded content when available.
8. **Notification denial after onboarding.** Settings must expose real permission state and open the native iOS Settings app.
9. **Small devices and Dynamic Type.** Avoid fixed screen heights, let cards wrap, keep controls at least 44pt, and use scrollable onboarding content for compact height.
10. **Lovable is dark-first.** Preserve dark visual fidelity while supplying a deliberate warm light appearance and system-driven mode.

## 10. Implementation order and verification gates

1. Baseline: identify project/Scheme/Bundle/deployment destination and complete an unchanged build.
2. Design System: extend `Theme.swift`; build.
3. Shared components: evolve `Components.swift`; build.
4. Welcome; build and inspect compact height, Dynamic Type, Apple callback wiring.
5. Notification onboarding; build and verify the existing permission call and skip state.
6. Native tabs/navigation; build and verify deep-link/event/project destinations.
7. Home; build and verify dashboard binding, refresh, loading/error/empty/unread/running/failed states.
8. Projects; build and verify derived badges/status from real loaded collections.
9. Project detail; build and verify load, pause/resume, endpoint copy, empty subsections.
10. Event detail; build and verify mark-read, sensitive reveal, selectable/copyable JSON, delivery states, ShareLink.
11. Settings/binding; build and verify real code generation, permission/settings, devices, sign-out, version.
12. Final: simulator build, targeted simulator launch/navigation smoke where authentication permits, small-device build, reference-repo cleanliness, and final `git diff --stat`/untracked file summary.
