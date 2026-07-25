// SPDX-License-Identifier: MPL-2.0
import Foundation
import OSLog
import StoreKit

enum BellwirePurchasePlan: String, CaseIterable, Identifiable {
    case yearly
    case monthly

    var id: String { rawValue }

    var productID: String {
        switch self {
        case .yearly: return "app.bellwire.pro.yearly"
        case .monthly: return "app.bellwire.pro.monthly"
        }
    }

    func title(locale: Locale) -> String {
        switch self {
        case .yearly: return String(localized: "Yearly", locale: locale)
        case .monthly: return String(localized: "Monthly", locale: locale)
        }
    }

    func renewalDescription(locale: Locale) -> String {
        switch self {
        case .yearly:
            return String(localized: "Billed yearly · best value", locale: locale)
        case .monthly:
            return String(localized: "Renews every month", locale: locale)
        }
    }
}

@MainActor
final class PurchaseManager: ObservableObject {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "app.bellwire",
        category: "StoreKit"
    )

    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case unavailable
    }

    @Published private(set) var products: [String: Product] = [:]
    @Published private(set) var eligibleTrialProductIDs: Set<String> = []
    @Published private(set) var purchasedProductIDs: Set<String> = []
    @Published private(set) var serverEntitlement: AccountEntitlement?
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var isUnavailableInCurrentStorefront = false
    @Published private(set) var isPurchasing = false
    @Published private(set) var isRestoring = false
    @Published var errorMessage: String?

    private var updatesTask: Task<Void, Never>?
    private var transactionUploader: ((String, String) async throws -> AccountEntitlement)?
    private var entitlementLoader: (() async throws -> AccountEntitlement)?

    var hasPro: Bool {
        serverEntitlement?.hasPro
            ?? !purchasedProductIDs.isDisjoint(with: Self.productIDs)
    }

    static let productIDs = Set(BellwirePurchasePlan.allCases.map(\.productID))

    init() {
        updatesTask = Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { return }
                await self.process(update)
            }
        }
    }

    func configure(
        transactionUploader: @escaping (String, String) async throws -> AccountEntitlement,
        entitlementLoader: @escaping () async throws -> AccountEntitlement
    ) {
        self.transactionUploader = transactionUploader
        self.entitlementLoader = entitlementLoader
    }

    deinit {
        updatesTask?.cancel()
    }

    func prepare() async {
        async let products: Void = loadProducts()
        async let entitlements: Void = refreshEntitlements()
        _ = await (products, entitlements)
        await refreshServerEntitlement()
    }

    func product(for plan: BellwirePurchasePlan) -> Product? {
        products[plan.productID]
    }

    func isTrialEligible(for plan: BellwirePurchasePlan) -> Bool {
        eligibleTrialProductIDs.contains(plan.productID)
    }

    func loadProducts() async {
        guard loadState != .loading else { return }
        loadState = .loading
        isUnavailableInCurrentStorefront = false
        errorMessage = nil

        do {
            let loaded = try await Product.products(for: Self.productIDs)
            products = Dictionary(uniqueKeysWithValues: loaded.map { ($0.id, $0) })
            let missingProductIDs = Self.productIDs.subtracting(products.keys)
            if missingProductIDs.isEmpty {
                loadState = .loaded
            } else {
                loadState = .unavailable
                isUnavailableInCurrentStorefront = true
                errorMessage = "Bellwire Pro is not available in your current App Store region."
                Self.logger.error(
                    "StoreKit did not return configured products: \(missingProductIDs.sorted().joined(separator: ", "), privacy: .public)"
                )
            }

            var eligibleTrials = Set<String>()
            for product in loaded {
                guard let subscription = product.subscription,
                      subscription.introductoryOffer?.paymentMode == .freeTrial,
                      await subscription.isEligibleForIntroOffer else {
                    continue
                }
                eligibleTrials.insert(product.id)
            }
            eligibleTrialProductIDs = eligibleTrials
        } catch {
            loadState = .unavailable
            isUnavailableInCurrentStorefront = false
            errorMessage = "Bellwire Pro products are temporarily unavailable. Please try again."
            Self.logger.error(
                "StoreKit product request failed: \(String(describing: error), privacy: .public)"
            )
        }
    }

    @discardableResult
    func purchase(_ product: Product, appAccountToken: UUID?) async -> Bool {
        guard !isPurchasing else { return false }
        isPurchasing = true
        errorMessage = nil
        defer { isPurchasing = false }

        do {
            guard let appAccountToken else {
                throw PurchaseVerificationError.missingAccountToken
            }
            let result: Product.PurchaseResult
            result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
            switch result {
            case .success(let verification):
                let transaction = try verified(verification)
                try await upload(verification.jwsRepresentation, source: "purchase")
                await transaction.finish()
                await refreshEntitlements()
                await refreshServerEntitlement()
                BellwireHaptics.success()
                return true
            case .pending:
                errorMessage = "Your purchase is pending approval."
            case .userCancelled:
                break
            @unknown default:
                errorMessage = "The purchase could not be completed."
            }
        } catch {
            errorMessage = "The purchase could not be completed. Please try again."
            BellwireHaptics.error()
        }

        return false
    }

    func restorePurchases() async {
        guard !isRestoring else { return }
        isRestoring = true
        errorMessage = nil
        defer { isRestoring = false }

        do {
            try await AppStore.sync()
            await refreshEntitlements(source: "restore")
            await refreshServerEntitlement()
            if hasPro {
                BellwireHaptics.success()
            } else {
                errorMessage = "No previous Bellwire Pro purchase was found."
            }
        } catch {
            errorMessage = "Purchases could not be restored. Please try again."
            BellwireHaptics.error()
        }
    }

    func refreshEntitlements(source: String = "sync") async {
        var activeProductIDs = Set<String>()

        for await entitlement in Transaction.currentEntitlements {
            guard case .verified(let transaction) = entitlement,
                  Self.productIDs.contains(transaction.productID),
                  transaction.revocationDate == nil else {
                continue
            }
            activeProductIDs.insert(transaction.productID)
            do {
                try await upload(entitlement.jwsRepresentation, source: source)
            } catch {
                errorMessage = "Your App Store purchase could not be synced with Bellwire."
            }
        }

        purchasedProductIDs = activeProductIDs
    }

    private func process(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        do {
            try await upload(result.jwsRepresentation, source: "sync")
            await transaction.finish()
        } catch {
            errorMessage = "Your App Store purchase could not be synced with Bellwire."
            return
        }
        await refreshEntitlements()
        await refreshServerEntitlement()
    }

    func refreshServerEntitlement() async {
        guard let entitlementLoader else { return }
        do {
            serverEntitlement = try await entitlementLoader()
        } catch {
            if serverEntitlement == nil {
                errorMessage = "Bellwire could not refresh your plan status."
            }
        }
    }

    private func upload(_ signedTransactionInfo: String, source: String) async throws {
        guard let transactionUploader else {
            throw PurchaseVerificationError.serverNotConfigured
        }
        serverEntitlement = try await transactionUploader(signedTransactionInfo, source)
    }

    private func verified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .verified(let value):
            return value
        case .unverified:
            throw PurchaseVerificationError.failed
        }
    }
}

private enum PurchaseVerificationError: Error {
    case failed
    case missingAccountToken
    case serverNotConfigured
}
