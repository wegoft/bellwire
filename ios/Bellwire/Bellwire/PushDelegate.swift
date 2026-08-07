// SPDX-License-Identifier: MPL-2.0
import UIKit
import UserNotifications

@MainActor
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel? {
        didSet {
            if let model, let pendingAPNsToken {
                self.pendingAPNsToken = nil
                Task { @MainActor in await model.receivedAPNsToken(pendingAPNsToken) }
            }
            schedulePendingNotificationResponseIfPossible()
        }
    }
    private var pendingAPNsToken: String?
    private var pendingNotificationResponse: PendingNotificationResponse?
    private var isApplicationActive = false

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        isApplicationActive = true
        schedulePendingNotificationResponseIfPossible()
    }

    func applicationWillResignActive(_ application: UIApplication) {
        isApplicationActive = false
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        guard model != nil else {
            pendingAPNsToken = token
            return
        }
        Task { @MainActor [weak self] in
            await self?.model?.receivedAPNsToken(token)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        model?.errorMessage = "This device could not register for push notifications."
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        Task { @MainActor [weak self] in
            completionHandler([.banner, .list, .sound, .badge])
            self?.model?.handleRemoteNotification()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let url = (response.notification.request.content.userInfo["deepLink"] as? String)
            .flatMap(URL.init(string:))
        Task { @MainActor [weak self] in
            // UIKit completes notification-launch state restoration from this callback.
            // Finish it on the main actor before mutating SwiftUI navigation state.
            completionHandler()
            self?.pendingNotificationResponse = PendingNotificationResponse(deepLink: url)
            self?.schedulePendingNotificationResponseIfPossible()
        }
    }

    private func schedulePendingNotificationResponseIfPossible() {
        guard isApplicationActive, model != nil, pendingNotificationResponse != nil else { return }
        Task { @MainActor [weak self] in
            await Task.yield()
            self?.consumePendingNotificationResponseIfPossible()
        }
    }

    private func consumePendingNotificationResponseIfPossible() {
        guard isApplicationActive,
              let model,
              let pendingNotificationResponse
        else { return }
        self.pendingNotificationResponse = nil
        model.handleRemoteNotification(deepLink: pendingNotificationResponse.deepLink)
    }
}

private struct PendingNotificationResponse: Sendable {
    let deepLink: URL?
}
