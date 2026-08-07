// SPDX-License-Identifier: MPL-2.0
import Foundation

struct ChecklistSurfaceItem: Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String?
    let state: String

    var isResolved: Bool {
        state == "completed" || state == "skipped"
    }
}

extension LiveSurfaceRecord {
    var checklistItems: [ChecklistSurfaceItem] {
        guard let values = content["items"]?.arrayValue else { return [] }
        return values.compactMap { value in
            guard let object = value.objectValue,
                  let id = object["id"]?.stringValue,
                  let title = object["title"]?.stringValue,
                  let state = object["state"]?.stringValue
            else { return nil }
            return ChecklistSurfaceItem(
                id: id,
                title: title,
                detail: object["detail"]?.stringValue,
                state: state
            )
        }
    }
}
