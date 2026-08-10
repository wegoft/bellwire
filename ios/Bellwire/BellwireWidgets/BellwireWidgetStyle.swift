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

struct BellwireWidgetProjectLabel: View {
    let name: String
    let icon: String
    let imageSize: Double
    let font: Font

    private let logoImage: UIImage?

    init(
        name: String,
        icon: String,
        logoData: Data?,
        imageSize: Double,
        font: Font
    ) {
        self.name = name
        self.icon = icon
        self.imageSize = imageSize
        self.font = font
        logoImage = logoData.flatMap(UIImage.init(data:))
    }

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: imageSize * 0.25, style: .continuous)
                    .fill(BellwireWidgetStyle.accent.opacity(0.14))
                if let logoImage {
                    Image(uiImage: logoImage)
                        .resizable()
                        .scaledToFill()
                } else if hasValidSymbol {
                    Image(systemName: icon)
                        .font(.system(size: imageSize * 0.52, weight: .semibold))
                        .foregroundStyle(BellwireWidgetStyle.accent)
                } else {
                    Text(initials)
                        .font(.system(size: imageSize * 0.36, weight: .semibold))
                        .foregroundStyle(BellwireWidgetStyle.accent)
                        .minimumScaleFactor(0.7)
                }
            }
            .frame(width: imageSize, height: imageSize)
            .clipShape(.rect(cornerRadius: imageSize * 0.25))
            .overlay {
                RoundedRectangle(cornerRadius: imageSize * 0.25, style: .continuous)
                    .stroke(.white.opacity(0.1), lineWidth: 0.5)
            }
            .accessibilityHidden(true)

            Text(name)
                .font(font)
                .bold()
                .foregroundStyle(BellwireWidgetStyle.accent)
                .lineLimit(1)
        }
    }

    private var hasValidSymbol: Bool {
        !icon.isEmpty && UIImage(systemName: icon) != nil
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
}
