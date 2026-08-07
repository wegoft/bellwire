// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct SurfaceSparkline: Shape {
    let values: [Double]

    func path(in rect: CGRect) -> Path {
        guard values.count > 1,
              let minimum = values.min(),
              let maximum = values.max()
        else { return Path() }

        let range = maximum - minimum
        let step = rect.width / CGFloat(values.count - 1)
        var path = Path()
        for (index, value) in values.enumerated() {
            let fraction = range == 0 ? 0.5 : (value - minimum) / range
            let point = CGPoint(
                x: rect.minX + CGFloat(index) * step,
                y: rect.maxY - fraction * rect.height
            )
            index == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        return path
    }
}
