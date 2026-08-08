// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct BellwireRefreshIndicator: View {
    let progress: CGFloat
    let isArmed: Bool
    let isRefreshing: Bool
    let isCompleting: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.locale) private var locale

    var body: some View {
        MascotView(
            state: mascotState,
            size: 50,
            facing: .right,
            animates: isRefreshing && !reduceMotion,
            enters: false
        )
        .scaleEffect(
            isBusy ? 1 : 0.7 + displayedProgress * 0.3,
            anchor: .bottom
        )
        .opacity(isBusy ? 1 : min(displayedProgress * 1.4, 1))
        .frame(width: 54, height: 54)
        .animation(
            reduceMotion ? nil : BellwireAnimation.quick,
            value: mascotState
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHidden(!isBusy)
    }

    private var displayedProgress: CGFloat {
        min(max(progress, 0), 1)
    }

    private var isBusy: Bool {
        isRefreshing || isCompleting
    }

    private var accessibilityLabel: Text {
        if isCompleting {
            Text("Refresh complete")
        } else {
            Text(AppConfig.branded("Refreshing Bellwire", locale: locale))
        }
    }

    private var mascotState: MascotState {
        if isCompleting {
            return .verified
        }
        if isRefreshing {
            return .connecting
        }
        if isArmed {
            return .listening
        }
        return .idle
    }
}
