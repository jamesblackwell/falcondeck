import CryptoKit
import Foundation

extension AppModel {
    /// The paired computer's files, cached on this device under a namespace
    /// derived from the pairing, so another computer never sees this one's copies.
    var files: RemoteFileStore {
        if let box = fileStoreBox, box.scope == sessionScope { return box.store }
        var identity = "unpaired"
        if let session = (try? sessionLoader()) ?? nil {
            identity = session.relay.absoluteString + ":" + session.sessionID + ":" + session.deviceID
        }
        let digest = SHA256.hash(data: Data(("files:" + identity).utf8))
        let namespace = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
        let root: URL
        if let base = sessionCacheRoot {
            root = base.appending(path: "FilePreviews/\(namespace)", directoryHint: .isDirectory)
        } else {
            root = FileDiskCache.defaultRoot(namespace: namespace)
        }
        let store = RemoteFileStore(relay: relay, cache: FileDiskCache(root: root))
        fileStoreBox = (sessionScope, store)
        return store
    }
}
