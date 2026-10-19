import { sameStoredDocument } from './workbenchRecovery'

// Compare transport snapshots only; all values are forwarded without calculation.
export function buildWorkbenchPatch(previous: object, next: object) {
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const updates: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue
    if (!sameStoredDocument(before[key], value)) updates[key] = value
    else if (!Object.hasOwn(before, key)) updates[key] = value
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key) || after[key] === undefined) removed.push(key)
  return { updates, removed, changed: Object.keys(updates).length > 0 || removed.length > 0 }
}
