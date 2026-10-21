import { sameStoredDocument } from './workbenchRecovery'

// Wire-format differences only. No business fields are interpreted or recalculated.
export type WorkbenchDelta =
  | { t: 'r'; v: unknown }
  | { t: 'o'; v: Record<string, WorkbenchDelta>; d: string[] }
  | { t: 'a'; l: number; v: Record<string, WorkbenchDelta> }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function buildWorkbenchDelta(before: unknown, after: unknown): WorkbenchDelta | null {
  if (sameStoredDocument(before, after)) return null
  if (Array.isArray(before) && Array.isArray(after)) {
    if (!before.length || !after.length) return { t: 'r', v: after }
    const entries: Record<string, WorkbenchDelta> = Object.create(null)
    for (let index = 0; index < after.length; index++) {
      const value = after[index] === undefined ? null : after[index]
      const change = index >= before.length ? { t: 'r' as const, v: value }
        : buildWorkbenchDelta(before[index] === undefined ? null : before[index], value)
      if (change) entries[String(index)] = change
    }
    if (Object.keys(entries).length === after.length && Object.values(entries).every(change => change.t === 'r')) return { t: 'r', v: after }
    return { t: 'a', l: after.length, v: entries }
  }
  if (object(before) && object(after)) {
    const entries: Record<string, WorkbenchDelta> = Object.create(null)
    const removed = Object.keys(before).filter(key => before[key] !== undefined && (!Object.hasOwn(after, key) || after[key] === undefined))
    for (const [key, value] of Object.entries(after)) {
      if (value === undefined) continue
      const change = !Object.hasOwn(before, key) || before[key] === undefined ? { t: 'r' as const, v: value } : buildWorkbenchDelta(before[key], value)
      if (change) entries[key] = change
    }
    return { t: 'o', v: entries, d: removed }
  }
  return { t: 'r', v: after }
}
