// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct TrendSurfaceCard: View {
    let surface: LiveSurfaceRecord

    var body: some View {
        let points = surface.trendPoints
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                SurfaceIdentity(surface: surface, size: 36)
                Spacer(minLength: 8)
                Text(currentValue(points))
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(BellwireTheme.ink)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .contentTransition(.numericText())
            }

            if points.count > 1 {
                HStack(alignment: .center, spacing: 8) {
                    Label(deltaText(points), systemImage: deltaSymbol(points))
                        .font(BellwireTypography.metadata.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(trendColor(points))
                    Spacer(minLength: 0)
                    Text("First to latest")
                        .font(BellwireTypography.metadata)
                        .foregroundStyle(BellwireTheme.mutedInk)
                }

                SurfaceSparkline(values: points.map(\.value))
                    .stroke(
                        trendColor(points),
                        style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
                    )
                    .frame(height: 70)
                    .background {
                        LinearGradient(
                            colors: [trendColor(points).opacity(0.10), .clear],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    }
                    .accessibilityHidden(true)

                HStack {
                    Text(points.first?.label ?? "")
                    Spacer()
                    Text(points.last?.label ?? "")
                }
                .font(BellwireTypography.metadata)
                .foregroundStyle(BellwireTheme.mutedInk)
            }
            SurfaceFooter(surface: surface)
        }
        .surfaceCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary(points))
    }

    private func currentValue(_ points: [TrendSurfacePoint]) -> String {
        if let display = surface.content["displayValue"]?.stringValue { return display }
        guard let value = points.last?.value else { return "—" }
        let formatted = value.formatted(.number.precision(.fractionLength(0...2)))
        return "\(formatted)\(surface.content["unit"]?.stringValue ?? "")"
    }

    private func delta(_ points: [TrendSurfacePoint]) -> Double {
        guard let first = points.first?.value, let last = points.last?.value else { return 0 }
        return last - first
    }

    private func deltaText(_ points: [TrendSurfacePoint]) -> String {
        guard let first = points.first?.value else { return "—" }
        let change = delta(points)
        if first != 0 {
            let formatted = (change / abs(first)).formatted(
                .percent.precision(.fractionLength(0...1))
            )
            return change > 0 ? "+\(formatted)" : formatted
        }
        let formatted = change.formatted(.number.precision(.fractionLength(0...2)))
        let unit = surface.content["unit"]?.stringValue ?? ""
        return change > 0 ? "+\(formatted)\(unit)" : "\(formatted)\(unit)"
    }

    private func deltaSymbol(_ points: [TrendSurfacePoint]) -> String {
        if delta(points) > 0 { return "arrow.up.right" }
        if delta(points) < 0 { return "arrow.down.right" }
        return "arrow.right"
    }

    private func trendColor(_ points: [TrendSurfacePoint]) -> Color {
        let change = delta(points)
        let goal = surface.content["goal"]?.stringValue ?? "neutral"
        if change == 0 || goal == "neutral" { return BellwireTheme.accent }
        let favorable = (goal == "up" && change > 0) || (goal == "down" && change < 0)
        return favorable ? BellwireTheme.live : BellwireTheme.danger
    }

    private func accessibilitySummary(_ points: [TrendSurfacePoint]) -> String {
        "\(surface.title), \(currentValue(points)), change \(deltaText(points))"
    }
}
