// SPDX-License-Identifier: MPL-2.0
import SwiftUI

enum BellwireWidgetStyle {
    static let accent = Color(red: 1.0, green: 0.58, blue: 0.08)
    static let background = Color(red: 0.055, green: 0.052, blue: 0.046)
    static let compactSpacing = 5.0
    static let standardSpacing = 8.0
}

func widgetSurfaceTitle(_ surface: BellwireNativeSurface) -> String {
    let redundantSuffix = " · \(surface.projectName)"
    guard surface.title.hasSuffix(redundantSuffix) else { return surface.title }
    return String(surface.title.dropLast(redundantSuffix.count))
}
