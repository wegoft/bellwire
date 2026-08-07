// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct ChecklistSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        let items = surface.checklistItems
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(surface: surface, size: 36)
                Spacer(minLength: 8)
                Text("\(resolvedCount(items))/\(items.count)")
                    .font(BellwireTypography.technicalStrong)
                    .monospacedDigit()
                    .foregroundStyle(summaryColor(items))
                    .contentTransition(.numericText())
            }

            if items.isEmpty {
                Text("No valid checklist items")
                    .font(BellwireTypography.metadata)
                    .foregroundStyle(BellwireTheme.mutedInk)
            } else {
                HStack(spacing: 5) {
                    ForEach(items) { item in
                        Capsule()
                            .fill(color(for: item.state).opacity(item.state == "pending" ? 0.24 : 1))
                            .frame(height: 6)
                    }
                }

                VStack(spacing: 11) {
                    ForEach(items) { item in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: symbol(for: item.state))
                                .font(.body.weight(.semibold))
                                .foregroundStyle(color(for: item.state))
                                .frame(width: 22, height: 22)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(BellwireTheme.ink)
                                    .strikethrough(item.state == "skipped")
                                if let detail = item.detail {
                                    Text(detail)
                                        .font(BellwireTypography.metadata)
                                        .foregroundStyle(BellwireTheme.mutedInk)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(item.title), \(localizedState(item.state))")
                    }
                }
            }
            SurfaceFooter(surface: surface)
        }
        .surfaceCard(isAlert: items.contains { $0.state == "failed" })
    }

    private func resolvedCount(_ items: [ChecklistSurfaceItem]) -> Int {
        items.count(where: { $0.isResolved })
    }

    private func summaryColor(_ items: [ChecklistSurfaceItem]) -> Color {
        if items.contains(where: { $0.state == "failed" }) { return BellwireTheme.danger }
        if resolvedCount(items) == items.count, !items.isEmpty { return BellwireTheme.live }
        if items.contains(where: { $0.state == "running" }) { return BellwireTheme.accent }
        return BellwireTheme.secondaryInk
    }

    private func symbol(for state: String) -> String {
        switch state {
        case "running": "arrow.triangle.2.circlepath"
        case "completed": "checkmark.circle.fill"
        case "failed": "xmark.circle.fill"
        case "skipped": "forward.circle.fill"
        default: "circle"
        }
    }

    private func color(for state: String) -> Color {
        switch state {
        case "running": BellwireTheme.accent
        case "completed": BellwireTheme.live
        case "failed": BellwireTheme.danger
        case "skipped": BellwireTheme.mutedInk
        default: BellwireTheme.secondaryInk
        }
    }

    private func localizedState(_ state: String) -> String {
        switch state {
        case "running": String(localized: "Running")
        case "completed": String(localized: "Completed")
        case "failed": String(localized: "Failed")
        case "skipped": String(localized: "Skipped")
        default: String(localized: "Pending")
        }
    }
}
