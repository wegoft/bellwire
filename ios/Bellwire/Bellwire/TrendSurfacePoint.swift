// SPDX-License-Identifier: MPL-2.0
import Foundation

struct TrendSurfacePoint: Hashable {
    let label: String
    let value: Double
}

extension LiveSurfaceRecord {
    var trendPoints: [TrendSurfacePoint] {
        guard let values = content["points"]?.arrayValue else { return [] }
        return values.compactMap { value in
            guard let object = value.objectValue,
                  let label = object["label"]?.stringValue,
                  let number = object["value"]?.numberValue,
                  number.isFinite
            else { return nil }
            return TrendSurfacePoint(label: label, value: number)
        }
    }
}
