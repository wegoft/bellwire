// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct LiveSurfaceLoadingView: View {
    enum Presentation {
        case card
        case compact
    }

    var presentation: Presentation = .card

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if reduceMotion {
                content(pulse: 0)
            } else {
                TimelineView(
                    .animation(
                        minimumInterval: 1.0 / 24.0,
                        paused: scenePhase != .active
                    )
                ) { timeline in
                    let seconds = timeline.date.timeIntervalSinceReferenceDate
                    let pulse = (sin(seconds * .pi * 2 / 1.35) + 1) / 2
                    content(pulse: pulse)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            Text(
                LocalizedStringKey(
                    presentation == .compact
                        ? "Refreshing live cards"
                        : "Loading live cards…"
                )
            )
        )
    }

    @ViewBuilder
    private func content(pulse: Double) -> some View {
        switch presentation {
        case .card:
            HStack(spacing: BellwireSpacing.small) {
                pulseDot(pulse: pulse)
                    .frame(width: 30, height: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Loading live cards…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BellwireTheme.ink)
                    Text("Syncing Hosted and Private sources.")
                        .font(.caption)
                        .foregroundStyle(BellwireTheme.mutedInk)
                }
                Spacer(minLength: 0)
            }
            .padding(BellwireSpacing.standard)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .background(
                BellwireTheme.surface,
                in: RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: BellwireRadius.card, style: .continuous)
                    .stroke(BellwireTheme.separator, lineWidth: 1)
            }
        case .compact:
            HStack(spacing: 6) {
                pulseDot(pulse: pulse)
                    .frame(width: 14, height: 14)
                Text("Refreshing live cards")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(BellwireTheme.live)
            }
            .padding(.horizontal, 9)
            .frame(minHeight: 26)
            .background(
                BellwireTheme.live.opacity(0.13),
                in: RoundedRectangle(cornerRadius: BellwireRadius.small, style: .continuous)
            )
        }
    }

    private func pulseDot(pulse: Double) -> some View {
        ZStack {
            Circle()
                .stroke(BellwireTheme.live.opacity(0.28 * (1 - pulse)), lineWidth: 2)
                .scaleEffect(1 + pulse * 0.52)
            Circle()
                .fill(BellwireTheme.live)
                .frame(width: 7, height: 7)
                .scaleEffect(0.88 + pulse * 0.12)
                .shadow(color: BellwireTheme.live.opacity(0.34), radius: 4)
        }
    }
}
