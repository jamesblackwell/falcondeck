import Foundation

/// Each compatibility frontend belongs to one daemon. Keep its typed IDs in
/// that daemon's namespace so opaque action results and view values agree.
struct NativeExtensionBridgeScope {
    let hostID: String?

    func localID(_ id: String) -> String {
        let value = NativeHostManager.split(id)
        return value.hostID == hostID ? value.id : id
    }

    func appID(_ id: String) throws -> String {
        let value = NativeHostManager.split(id)
        guard value.hostID == nil || value.hostID == hostID else {
            throw PilotError("This task belongs to another server.")
        }
        return hostID.map { NativeHostManager.namespace(hostID: $0, id: value.id) } ?? value.id
    }

    func appView(_ view: JSON) -> JSON {
        var scope = view["scope"]
        if ["thread", "workspace"].contains(scope["kind"].string) {
            scope = scope.setting("id", .string(localID(scope["id"].string)))
        }
        return .object(["viewId": view["view_id"], "scope": scope, "value": view["value"], "updatedAt": view["updated_at"]])
    }
}
