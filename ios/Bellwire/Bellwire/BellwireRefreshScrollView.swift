// SPDX-License-Identifier: MPL-2.0
import SwiftUI

struct BellwireRefreshScrollView<Content: View>: View {
    let action: () async -> Void
    @ViewBuilder let content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pullDistance: CGFloat = 0
    @State private var isDragging = false
    @State private var isArmed = false
    @State private var hasPlayedThresholdHaptic = false
    @State private var isRefreshing = false
    @State private var isCompleting = false
    @State private var refreshRequestID = 0

    private let refreshThreshold: CGFloat = 72
    private let refreshingInset: CGFloat = 56

    init(
        action: @escaping () async -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.action = action
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear
                    .frame(height: 0)
                    .onGeometryChange(for: CGFloat.self) { proxy in
                        max(
                            0,
                            proxy.frame(in: .named(Self.coordinateSpaceName)).minY
                        )
                    } action: { newValue in
                        updatePullDistance(newValue)
                    }

                Color.clear
                    .frame(height: isBusy ? refreshingInset : 0)
                    .animation(
                        reduceMotion ? nil : BellwireAnimation.standard,
                        value: isBusy
                    )

                content
            }
        }
        .coordinateSpace(name: Self.coordinateSpaceName)
        .scrollBounceBehavior(.always)
        .simultaneousGesture(refreshGesture)
        .overlay(alignment: .top) {
            BellwireRefreshIndicator(
                progress: pullProgress,
                isArmed: isArmed,
                isRefreshing: isRefreshing,
                isCompleting: isCompleting
            )
            .offset(y: isBusy ? 3 : -47 + min(pullProgress, 1) * 50)
            .animation(
                reduceMotion ? nil : BellwireAnimation.standard,
                value: isBusy
            )
            .zIndex(1)
        }
        .task(id: refreshRequestID) {
            guard isRefreshing else { return }
            await action()
            guard !Task.isCancelled else { return }

            withAnimation(reduceMotion ? nil : BellwireAnimation.quick) {
                isRefreshing = false
                isCompleting = true
            }
            guard !reduceMotion else {
                isCompleting = false
                return
            }

            try? await Task.sleep(for: .milliseconds(320))
            guard !Task.isCancelled else { return }
            withAnimation(BellwireAnimation.quick) {
                isCompleting = false
            }
        }
        .accessibilityAction(named: Text("Refresh")) {
            requestRefresh()
        }
    }

    private static var coordinateSpaceName: String {
        "BellwireRefreshScrollView"
    }

    private var pullProgress: CGFloat {
        min(max(pullDistance / refreshThreshold, 0), 1)
    }

    private var isBusy: Bool {
        isRefreshing || isCompleting
    }

    private var refreshGesture: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                guard !isBusy,
                      value.translation.height > 0,
                      abs(value.translation.height) > abs(value.translation.width)
                else { return }
                isDragging = true
            }
            .onEnded { _ in
                let shouldRefresh = isDragging && isArmed
                isDragging = false
                isArmed = false
                hasPlayedThresholdHaptic = false
                if shouldRefresh {
                    requestRefresh()
                }
            }
    }

    private func updatePullDistance(_ newValue: CGFloat) {
        guard !isBusy else {
            pullDistance = 0
            return
        }
        pullDistance = newValue
        guard isDragging else { return }

        let nextIsArmed = newValue >= refreshThreshold
        if nextIsArmed && !hasPlayedThresholdHaptic {
            BellwireHaptics.selection()
            hasPlayedThresholdHaptic = true
        }
        isArmed = nextIsArmed
    }

    private func requestRefresh() {
        guard !isBusy else { return }
        isRefreshing = true
        pullDistance = 0
        isArmed = false
        refreshRequestID += 1
    }
}
