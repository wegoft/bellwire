// SPDX-License-Identifier: MPL-2.0
import CryptoKit
import Foundation
import UIKit

actor ProjectLogoCache {
    static let shared = ProjectLogoCache()

    private static let maximumImageBytes = 5 * 1_024 * 1_024
    private static let maximumDiskEntries = 200
    private static let maximumDiskBytes = 50 * 1_024 * 1_024

    private let memoryCache = NSCache<NSURL, NSData>()
    private let session: URLSession
    private let fileManager: FileManager
    private let directoryURL: URL
    private var inFlight: [URL: Task<Data?, Never>] = [:]

    init(
        fileManager: FileManager = .default,
        session: URLSession = .shared
    ) {
        self.fileManager = fileManager
        self.session = session

        let cacheRoot = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        directoryURL = cacheRoot
            .appendingPathComponent("Bellwire", isDirectory: true)
            .appendingPathComponent("ProjectLogos", isDirectory: true)

        memoryCache.countLimit = Self.maximumDiskEntries
        memoryCache.totalCostLimit = 20 * 1_024 * 1_024
        try? fileManager.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
    }

    func data(for url: URL) async -> Data? {
        guard url.scheme?.lowercased() == "https" else { return nil }

        let cacheKey = url as NSURL
        if let cached = memoryCache.object(forKey: cacheKey) {
            return cached as Data
        }

        let fileURL = diskURL(for: url)
        if let cached = readValidImage(at: fileURL) {
            memoryCache.setObject(cached as NSData, forKey: cacheKey, cost: cached.count)
            touch(fileURL)
            return cached
        }

        if let existingTask = inFlight[url] {
            return await existingTask.value
        }

        let request = Self.request(for: url)
        let maximumImageBytes = Self.maximumImageBytes
        let task = Task<Data?, Never> { [session] in
            do {
                let (data, response) = try await session.data(for: request)
                guard !Task.isCancelled,
                      let response = response as? HTTPURLResponse,
                      (200..<300).contains(response.statusCode),
                      response.expectedContentLength <= Int64(maximumImageBytes),
                      data.count <= maximumImageBytes,
                      UIImage(data: data) != nil
                else {
                    return nil
                }
                return data
            } catch {
                return nil
            }
        }

        inFlight[url] = task
        let downloaded = await task.value
        inFlight[url] = nil

        guard let downloaded else { return nil }
        memoryCache.setObject(
            downloaded as NSData,
            forKey: cacheKey,
            cost: downloaded.count
        )
        do {
            try downloaded.write(to: fileURL, options: .atomic)
            pruneDiskCache()
        } catch {
            // The in-memory image remains usable when the OS denies a cache write.
        }
        return downloaded
    }

    private static func request(for url: URL) -> URLRequest {
        var request = URLRequest(
            url: url,
            cachePolicy: .returnCacheDataElseLoad,
            timeoutInterval: 12
        )
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        return request
    }

    private func diskURL(for url: URL) -> URL {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let filename = digest.map { String(format: "%02x", $0) }.joined()
        return directoryURL.appendingPathComponent(filename).appendingPathExtension("image")
    }

    private func readValidImage(at url: URL) -> Data? {
        guard let data = try? Data(
            contentsOf: url,
            options: [.mappedIfSafe, .uncached]
        ),
        data.count <= Self.maximumImageBytes,
        UIImage(data: data) != nil
        else {
            try? fileManager.removeItem(at: url)
            return nil
        }
        return data
    }

    private func touch(_ url: URL) {
        try? fileManager.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: url.path
        )
    }

    private func pruneDiskCache() {
        let keys: Set<URLResourceKey> = [
            .contentModificationDateKey,
            .fileSizeKey,
            .isRegularFileKey,
        ]
        guard let urls = try? fileManager.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: Array(keys),
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        let files = urls.compactMap { url -> (url: URL, date: Date, size: Int)? in
            guard let values = try? url.resourceValues(forKeys: keys),
                  values.isRegularFile == true
            else {
                return nil
            }
            return (
                url,
                values.contentModificationDate ?? .distantPast,
                values.fileSize ?? 0
            )
        }
        .sorted { $0.date > $1.date }

        var totalBytes = 0
        for (index, file) in files.enumerated() {
            totalBytes += file.size
            if index >= Self.maximumDiskEntries || totalBytes > Self.maximumDiskBytes {
                try? fileManager.removeItem(at: file.url)
            }
        }
    }
}
