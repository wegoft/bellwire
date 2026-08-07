// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct StatusSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(surface: surface, size: 36)
                Spacer(minLength: 8)
                Label(statusLabel, systemImage: statusSymbol)
                    .font(BellwireTypography.metadata.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 32)
                    .background(statusColor.opacity(0.13), in: Capsule())
            }
            SurfaceFooter(surface: surface)
        }
        .surfaceCard(isAlert: statusState == "critical")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(surface.title), \(statusLabel)")
    }

    private var statusState: String {
        surface.content["state"]?.stringValue ?? "neutral"
    }

    private var statusLabel: String {
        if let label = surface.content["label"]?.stringValue { return label }
        switch statusState {
        case "running": return String(localized: "Running")
        case "success": return String(localized: "Healthy")
        case "warning": return String(localized: "Attention")
        case "critical": return String(localized: "Critical")
        case "paused": return String(localized: "Paused")
        default: return String(localized: "Neutral")
        }
    }

    private var statusSymbol: String {
        switch statusState {
        case "running": "arrow.triangle.2.circlepath"
        case "success": "checkmark.circle.fill"
        case "warning": "exclamationmark.triangle.fill"
        case "critical": "xmark.octagon.fill"
        case "paused": "pause.circle.fill"
        default: "circle.dotted"
        }
    }

    private var statusColor: Color {
        switch statusState {
        case "running": BellwireTheme.accent
        case "success": BellwireTheme.live
        case "warning": Color(red: 0.82, green: 0.60, blue: 0.16)
        case "critical": BellwireTheme.danger
        case "paused": BellwireTheme.mutedInk
        default: BellwireTheme.secondaryInk
        }
    }
}
