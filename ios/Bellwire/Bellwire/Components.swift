// SPDX-License-Identifier: MPL-2.0
import SwiftUI
import UIKit

enum BellwireIcons {
    static let home = "house"
    static let projects = "square.grid.2x2"
    static let events = "bolt"
    static let settings = "gearshape"
    static let notification = "bell.fill"
    static let binding = "key.horizontal"
    static let device = "iphone"
    static let copy = "doc.on.doc"
}

struct BellwireMark: View {
    var size: CGFloat = 54

    var body: some View {
        Image("BellwireLogo")
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.23, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.23, style: .continuous)
                    .stroke(BellwireTheme.separator.opacity(0.72), lineWidth: 1)
            }
            .accessibilityHidden(true)
    }
}

enum MascotState: Hashable {
    case idle
    case listening
    case allQuiet
    case connecting
    case testing
    case accepted
    case awaitingApproval
    case verified
    case issue
    case recovered

    fileprivate var assetName: String {
        switch self {
        case .idle, .allQuiet:
            "MascotSignalBird"
        case .listening:
            "MascotListening"
        case .connecting, .testing:
            "MascotConnecting"
        case .accepted, .awaitingApproval:
            "MascotAccepted"
        case .verified, .recovered:
            "MascotVerified"
        case .issue:
            "MascotIssue"
        }
    }

    fileprivate var motion: MascotMotionProfile {
        switch self {
        case .idle:
            MascotMotionProfile(
                restingTilt: 0,
                sway: 0.18,
                lift: 0.42,
                breath: 0.006,
                gestureDelay: 10.5,
                gesturePeriod: 17.0,
                gestureDuration: 0.9,
                gestureTilt: 0.7,
                gestureLift: 0.35,
                gestureReach: 0,
                repeatsGesture: false
            )
        case .listening:
            MascotMotionProfile(
                restingTilt: -0.45,
                sway: 0.28,
                lift: 0.52,
                breath: 0.007,
                gestureDelay: 3.8,
                gesturePeriod: 9.6,
                gestureDuration: 1.1,
                gestureTilt: -1.65,
                gestureLift: 0.8,
                gestureReach: 0.45,
                repeatsGesture: true
            )
        case .allQuiet:
            MascotMotionProfile(
                restingTilt: 0.25,
                sway: 0.14,
                lift: 0.34,
                breath: 0.005,
                gestureDelay: 9.0,
                gesturePeriod: 17.8,
                gestureDuration: 0.85,
                gestureTilt: 0.55,
                gestureLift: 0.3,
                gestureReach: 0,
                repeatsGesture: true
            )
        case .connecting, .testing:
            MascotMotionProfile(
                restingTilt: 0.65,
                sway: 0.22,
                lift: 0.55,
                breath: 0.008,
                gestureDelay: 1.8,
                gesturePeriod: 4.8,
                gestureDuration: 0.9,
                gestureTilt: -1.25,
                gestureLift: 0.7,
                gestureReach: 1.35,
                repeatsGesture: true
            )
        case .accepted, .awaitingApproval:
            MascotMotionProfile(
                restingTilt: 0,
                sway: 0.12,
                lift: 0.3,
                breath: 0.004,
                gestureDelay: 1.2,
                gesturePeriod: 30,
                gestureDuration: 0.7,
                gestureTilt: -0.55,
                gestureLift: 0.2,
                gestureReach: 0,
                repeatsGesture: false
            )
        case .verified, .recovered:
            MascotMotionProfile(
                restingTilt: -0.2,
                sway: 0.1,
                lift: 0.3,
                breath: 0.004,
                gestureDelay: 0.15,
                gesturePeriod: 30,
                gestureDuration: 0.9,
                gestureTilt: 1.2,
                gestureLift: 0.45,
                gestureReach: 0,
                repeatsGesture: false
            )
        case .issue:
            MascotMotionProfile(
                restingTilt: 0.35,
                sway: 0.08,
                lift: 0.22,
                breath: 0.003,
                gestureDelay: 0,
                gesturePeriod: 30,
                gestureDuration: 0,
                gestureTilt: 0,
                gestureLift: 0,
                gestureReach: 0,
                repeatsGesture: false
            )
        }
    }
}

enum MascotFacing {
    case left
    case right

    fileprivate var horizontalScale: CGFloat {
        self == .right ? 1 : -1
    }

    fileprivate var direction: Double {
        self == .right ? 1 : -1
    }
}

private struct MascotMotionProfile {
    let restingTilt: Double
    let sway: Double
    let lift: Double
    let breath: Double
    let gestureDelay: Double
    let gesturePeriod: Double
    let gestureDuration: Double
    let gestureTilt: Double
    let gestureLift: Double
    let gestureReach: Double
    let repeatsGesture: Bool
}

struct MascotView: View {
    let state: MascotState
    var size: CGFloat
    var facing: MascotFacing = .right
    var animates = true
    var enters = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var hasEntered = false
    @State private var motionStart = Date()
    @State private var displayedState: MascotState

    init(
        state: MascotState,
        size: CGFloat,
        facing: MascotFacing = .right,
        animates: Bool = true,
        enters: Bool = true
    ) {
        self.state = state
        self.size = size
        self.facing = facing
        self.animates = animates
        self.enters = enters
        _displayedState = State(initialValue: state)
    }

    var body: some View {
        Group {
            if reduceMotion || !animates {
                mascot(state: displayedState, breath: 0, drift: 0, gesture: 0)
            } else {
                TimelineView(
                    .animation(
                        minimumInterval: 1.0 / 24.0,
                        paused: scenePhase != .active
                    )
                ) { timeline in
                    let seconds = max(0, timeline.date.timeIntervalSince(motionStart))
                    let breath = sin(seconds * .pi * 2 / 6.2)
                    let drift = sin(seconds * .pi * 2 / 11.7) * 0.68
                        + sin(seconds * .pi * 2 / 17.3 + 0.9) * 0.32
                    mascot(
                        state: displayedState,
                        breath: breath,
                        drift: drift,
                        gesture: gestureProgress(for: displayedState, at: seconds)
                    )
                }
            }
        }
        .frame(width: size, height: size)
        .opacity(enters && !reduceMotion ? (hasEntered ? 1 : 0) : 1)
        .scaleEffect(enters && !reduceMotion ? (hasEntered ? 1 : 0.96) : 1, anchor: .bottom)
        .offset(y: enters && !reduceMotion ? (hasEntered ? 0 : 6) : 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            motionStart = Date()
            guard enters, !reduceMotion else {
                hasEntered = true
                return
            }
            withAnimation(BellwireAnimation.mascotArrival.delay(0.08)) {
                hasEntered = true
            }
        }
        .onChange(of: reduceMotion) { _, isReduced in
            if isReduced {
                hasEntered = true
            }
        }
        .onChange(of: state) { _, newState in
            motionStart = Date()
            if reduceMotion {
                displayedState = newState
            } else {
                withAnimation(BellwireAnimation.standard) {
                    displayedState = newState
                }
            }
        }
    }

    private func mascot(
        state: MascotState,
        breath: Double,
        drift: Double,
        gesture: Double
    ) -> some View {
        let motion = state.motion
        let direction = facing.direction
        let verticalLift = -breath * motion.lift - gesture * motion.gestureLift
        let horizontalReach = gesture * motion.gestureReach * direction

        return ZStack {
            Ellipse()
                .fill(Color.black.opacity(0.16))
                .frame(width: size * 0.34, height: max(2, size * 0.055))
                .blur(radius: max(1, size * 0.025))
                .scaleEffect(x: 1 - breath * 0.035, y: 1)
                .opacity(0.62 - breath * 0.08 - gesture * 0.06)
                .offset(
                    x: size * 0.045 * facing.horizontalScale,
                    y: size * 0.355
                )

            Image(state.assetName)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .scaleEffect(
                    x: facing.horizontalScale * (1 + breath * 0.0015),
                    y: 1 + breath * motion.breath - gesture * 0.0015,
                    anchor: .bottom
                )
                .rotationEffect(
                    .degrees(
                        (motion.restingTilt + drift * motion.sway + gesture * motion.gestureTilt)
                            * direction
                    ),
                    anchor: .bottom
                )
                .offset(
                    x: CGFloat(horizontalReach),
                    y: CGFloat(verticalLift)
                )
                .id(state)
                .transition(.opacity.combined(with: .scale(scale: 0.985, anchor: .bottom)))
        }
        .animation(BellwireAnimation.standard, value: state)
    }

    private func gestureProgress(for state: MascotState, at seconds: Double) -> Double {
        let motion = state.motion
        guard motion.gestureDuration > 0 else { return 0 }
        guard seconds >= motion.gestureDelay else { return 0 }
        let elapsed = seconds - motion.gestureDelay
        if !motion.repeatsGesture, elapsed >= motion.gestureDuration { return 0 }
        let cycle = motion.repeatsGesture
            ? elapsed.truncatingRemainder(dividingBy: motion.gesturePeriod)
            : elapsed
        guard cycle < motion.gestureDuration else { return 0 }
        return sin((cycle / motion.gestureDuration) * .pi)
    }
}

struct SignalBreathingGlow: View {
    var intensity = 1.0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if reduceMotion {
                glow(pulse: 0, drift: 0)
            } else {
                TimelineView(
                    .animation(
                        minimumInterval: 1.0 / 24.0,
                        paused: scenePhase != .active
                    )
                ) { timeline in
                    let seconds = timeline.date.timeIntervalSinceReferenceDate
                    let pulse = sin(seconds * .pi * 2 / 7.8) * 0.72
                        + sin(seconds * .pi * 2 / 12.6 + 1.4) * 0.28
                    let drift = sin(seconds * .pi * 2 / 18.0 + 0.6)
                    glow(pulse: pulse, drift: drift)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func glow(pulse: Double, drift: Double) -> some View {
        ZStack {
            BellwireTheme.amberGlow
                .opacity((0.66 + pulse * 0.1) * intensity)
                .scaleEffect(
                    1 + CGFloat(pulse) * 0.018,
                    anchor: .topTrailing
                )
                .offset(
                    x: CGFloat(drift) * 3.5,
                    y: -CGFloat(pulse) * 2
                )

            BellwireTheme.amberGlowLeading
                .opacity((0.5 - pulse * 0.07) * intensity)
                .scaleEffect(
                    1 - CGFloat(pulse) * 0.012,
                    anchor: .bottomLeading
                )
                .offset(
                    x: -CGFloat(drift) * 2.5,
                    y: CGFloat(pulse) * 1.5
                )
        }
    }
}

struct ProjectAvatarView: View {
    let name: String
    let icon: String
    var size: CGFloat = 44
    var logoURL: URL? = nil

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                .fill(BellwireTheme.raisedSurface)
            if hasValidSymbol {
                Image(systemName: icon)
                    .font(.system(size: size * 0.39, weight: .semibold))
                    .foregroundStyle(BellwireTheme.secondaryInk)
            } else {
                Text(initials)
                    .font(.system(size: size * 0.34, weight: .semibold, design: .default))
                    .tracking(-0.35)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(BellwireTheme.secondaryInk)
            }
            if let logoURL {
                CachedProjectLogo(url: logoURL)
                .frame(width: size, height: size)
                .clipped()
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                .stroke(Color.black.opacity(0.1), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }

    private var initials: String {
        let normalized = name.lowercased()
        if normalized.contains("videosays") { return "VS" }
        if normalized.contains("bellwire") { return "BW" }
        let words = name.split(separator: " ").prefix(2)
        if words.count == 1 {
            let capitals = name.filter(\.isUppercase)
            if capitals.count >= 2 { return String(capitals.prefix(2)) }
        }
        let value = words.compactMap(\.first).map(String.init).joined().uppercased()
        return value.isEmpty ? "BW" : value
    }

    private var hasValidSymbol: Bool {
        !icon.isEmpty && UIImage(systemName: icon) != nil
    }
}

private struct CachedProjectLogo: View {
    let url: URL
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .background(BellwireTheme.surface)
                    .transition(.opacity)
            } else {
                Color.clear
            }
        }
        .task(id: url) {
            image = nil
            guard let data = await ProjectLogoCache.shared.data(for: url),
                  !Task.isCancelled,
                  let loadedImage = UIImage(data: data)
            else {
                return
            }
            withAnimation(BellwireAnimation.quick) {
                image = loadedImage
            }
        }
    }
}

struct ProjectGlyph: View {
    let icon: String
    var size: CGFloat = 44

    var body: some View {
        ProjectAvatarView(name: icon.humanizedEventType, icon: icon, size: size)
    }
}

struct SectionHeaderView: View {
    let title: String
    var hint: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(LocalizedStringKey(title))
                .font(BellwireTypography.sectionTitle)
                .foregroundStyle(BellwireTheme.secondaryInk)
            Spacer()
            if let hint, !hint.isEmpty {
                Text(LocalizedStringKey(hint))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BellwireTheme.accent)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct TechnicalDisclosure<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 0) {
                Divider().overlay(BellwireTheme.separator)
                content()
            }
            .padding(.top, BellwireSpacing.compact)
        } label: {
            Label {
                Text(LocalizedStringKey(title))
                    .font(.subheadline.weight(.medium))
            } icon: {
                Image(systemName: "terminal")
                    .foregroundStyle(BellwireTheme.mutedInk)
            }
            .foregroundStyle(BellwireTheme.ink)
            .frame(minHeight: 48)
        }
        .tint(BellwireTheme.mutedInk)
        .padding(.horizontal, BellwireSpacing.standard)
        .bellwireListGroup()
    }
}

struct StatusBadgeView: View {
    let text: String
    let color: Color
    var showsDot = true

    var body: some View {
        HStack(spacing: 6) {
            if showsDot {
                Circle()
                    .fill(color)
                    .frame(width: 7, height: 7)
                    .shadow(color: color.opacity(0.34), radius: 4)
            }
            Text(LocalizedStringKey(text))
                .lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .frame(minHeight: 26)
        .background(color.opacity(0.13), in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous))
        .accessibilityLabel(Text(LocalizedStringKey(text)))
    }
}

struct StatusLabel: View {
    let text: String
    let color: Color

    var body: some View {
        StatusBadgeView(text: text, color: color)
    }
}

struct DigestMetricView: View {
    let value: Int
    let label: String
    var isAccented = false

    var body: some View {
        VStack(alignment: .leading, spacing: BellwireSpacing.micro) {
            Text(value.formatted())
                .font(BellwireTypography.metric)
                .monospacedDigit()
                .foregroundStyle(isAccented ? BellwireTheme.accent : BellwireTheme.ink)
                .contentTransition(.numericText())
            Text(LocalizedStringKey(label.lowercased()))
                .font(.caption2)
                .tracking(0.4)
                .foregroundStyle(BellwireTheme.mutedInk)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }
}

struct PrimaryButton: View {
    let title: String
    var systemImage: String?
    var isLoading = false
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: BellwireSpacing.compact) {
                if isLoading {
                    ProgressView().tint(BellwireTheme.primaryButtonForeground)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(LocalizedStringKey(title))
                    .font(.body.weight(.semibold))
            }
            .foregroundStyle(BellwireTheme.primaryButtonForeground)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .background(BellwireTheme.primaryButtonBackground, in: RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(isDisabled || isLoading)
        .opacity(isDisabled ? 0.5 : 1)
    }
}

struct SecondaryButton: View {
    let title: String
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: BellwireSpacing.compact) {
                if let systemImage { Image(systemName: systemImage) }
                Text(LocalizedStringKey(title)).font(.body.weight(.semibold))
            }
            .foregroundStyle(BellwireTheme.ink)
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .background(BellwireTheme.surface, in: RoundedRectangle(cornerRadius: BellwireRadius.control, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
    }
}

struct ErrorBanner: View {
    let message: String
    var title = "Something went wrong"
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: BellwireSpacing.small) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(BellwireTheme.danger)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(LocalizedStringKey(title))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(BellwireTheme.ink)
                Text(LocalizedStringKey(message))
                    .font(.caption)
                    .foregroundStyle(BellwireTheme.secondaryInk)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel("Dismiss error")
        }
        .padding(.leading, BellwireSpacing.standard)
        .padding(.vertical, BellwireSpacing.small)
        .padding(.trailing, BellwireSpacing.micro)
        .background(BellwireTheme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
                .stroke(BellwireTheme.danger.opacity(0.25), lineWidth: 1)
        }
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let message: String
    var mascotState: MascotState? = nil
    var mascotFacing: MascotFacing = .right

    var body: some View {
        VStack(spacing: BellwireSpacing.small) {
            if let mascotState {
                MascotView(
                    state: mascotState,
                    size: 68,
                    facing: mascotFacing
                )
            } else {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(BellwireTheme.accent)
                    .frame(width: 56, height: 56)
                    .background(BellwireTheme.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
                    .accessibilityHidden(true)
            }
            Text(LocalizedStringKey(title))
                .font(.headline)
                .foregroundStyle(BellwireTheme.ink)
            Text(LocalizedStringKey(message))
                .font(.subheadline)
                .foregroundStyle(BellwireTheme.secondaryInk)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 290)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, BellwireSpacing.roomy)
        .padding(.vertical, 38)
        .accessibilityElement(children: .combine)
    }
}

struct LoadingEventRows: View {
    var count = 4

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { index in
                HStack(spacing: BellwireSpacing.small) {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(BellwireTheme.raisedSurface)
                        .frame(width: 40, height: 40)
                    VStack(alignment: .leading, spacing: 7) {
                        RoundedRectangle(cornerRadius: 3).frame(width: 138, height: 11)
                        RoundedRectangle(cornerRadius: 3).frame(maxWidth: 205).frame(height: 9)
                    }
                    .foregroundStyle(BellwireTheme.tertiarySurface)
                    Spacer()
                }
                .padding(.vertical, 13)
                if index < count - 1 {
                    Divider().overlay(BellwireTheme.separator).padding(.leading, 52)
                }
            }
        }
        .padding(.horizontal, BellwireSpacing.standard)
        .bellwireListGroup()
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
    }
}

struct SettingsRowView<Accessory: View>: View {
    let icon: String
    let title: String
    var hint: String?
    var tone: Color = BellwireTheme.ink
    @ViewBuilder let accessory: () -> Accessory

    var body: some View {
        HStack(spacing: BellwireSpacing.small) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(tone == BellwireTheme.ink ? BellwireTheme.secondaryInk : tone)
                .frame(width: 32, height: 32)
                .background(BellwireTheme.raisedSurface, in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(LocalizedStringKey(title))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(tone)
                if let hint {
                    Text(LocalizedStringKey(hint))
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.mutedInk)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            accessory()
        }
        .padding(.vertical, 13)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct DeviceRowView: View {
    let device: DeviceRecord
    var onDelete: (() -> Void)?

    var body: some View {
        SettingsRowView(
            icon: BellwireIcons.device,
            title: device.name,
            hint: device.appVersion.map { "\(AppConfig.displayName) \($0)" }
                ?? AppConfig.displayName
        ) {
            HStack(spacing: BellwireSpacing.compact) {
                StatusBadgeView(
                    text: device.pushEnabled ? "Push on" : "Push off",
                    color: device.pushEnabled ? BellwireTheme.success : BellwireTheme.mutedInk,
                    showsDot: false
                )
                if let onDelete {
                    Menu {
                        Button("Remove device", role: .destructive, action: onDelete)
                    } label: {
                        Label("Device options", systemImage: "ellipsis")
                            .labelStyle(.iconOnly)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(BellwireTheme.mutedInk)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Device options for \(device.name)")
                }
            }
        }
    }
}

struct StructuredFieldRow: View {
    let key: String
    let value: String
    var isSensitive = false
    var isRevealed = true
    var reveal: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: BellwireSpacing.standard) {
            Text(key)
                .font(BellwireTypography.technical)
                .foregroundStyle(BellwireTheme.mutedInk)
                .frame(maxWidth: .infinity, alignment: .leading)
            if isSensitive && !isRevealed, let reveal {
                Button(action: reveal) {
                    Label("Hidden", systemImage: "eye.slash")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BellwireTheme.accent)
                        .frame(minHeight: 44)
                }
                .buttonStyle(PressableButtonStyle())
            } else {
                Text(value)
                    .font(BellwireTypography.technical)
                    .foregroundStyle(BellwireTheme.ink)
                    .multilineTextAlignment(.trailing)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

struct DeliveryTimelineView: View {
    let deliveries: [DeliveryRecord]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            timelineRow(label: "Event received", detail: nil, color: BellwireTheme.success, isLast: deliveries.isEmpty)
            ForEach(Array(deliveries.enumerated()), id: \.element.id) { index, delivery in
                timelineRow(
                    label: deliveryLabel(delivery.status),
                    detail: "Attempt \(delivery.attemptCount)",
                    color: deliveryColor(delivery.status),
                    isLast: index == deliveries.count - 1
                )
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func timelineRow(label: String, detail: String?, color: Color, isLast: Bool) -> some View {
        HStack(alignment: .top, spacing: BellwireSpacing.small) {
            VStack(spacing: 0) {
                Circle()
                    .fill(color)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(color.opacity(0.25), lineWidth: 4))
                if !isLast {
                    Rectangle().fill(BellwireTheme.strongSeparator).frame(width: 1, height: 34)
                }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(BellwireTheme.ink)
                Spacer()
                if let detail {
                    Text(detail)
                        .font(BellwireTypography.technical)
                        .monospacedDigit()
                        .foregroundStyle(BellwireTheme.mutedInk)
                }
            }
            .padding(.top, -4)
        }
    }

    private func deliveryLabel(_ status: String) -> String {
        switch status {
        case "accepted_by_apns": return "Accepted by APNs"
        case "failed": return "Delivery failed"
        default: return "Queued for delivery"
        }
    }

    private func deliveryColor(_ status: String) -> Color {
        switch status {
        case "accepted_by_apns": return BellwireTheme.success
        case "failed": return BellwireTheme.danger
        default: return BellwireTheme.warning
        }
    }
}

#if DEBUG
#Preview("Mascot states") {
    ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 118))], spacing: 24) {
            ForEach(
                [
                    MascotState.allQuiet,
                    .listening,
                    .connecting,
                    .accepted,
                    .verified,
                    .issue
                ],
                id: \.self
            ) { state in
                VStack(spacing: 8) {
                    MascotView(state: state, size: 92, animates: false, enters: false)
                    Text(String(describing: state))
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.secondaryInk)
                }
            }
        }
        .padding()
    }
    .background(BellwireTheme.background)
}
#endif
