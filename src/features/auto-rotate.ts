import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Hand-off between the rotation hooks and `clauditor run`.
 *
 * `clauditor run` sets ROTATE_ENV on the claude it spawns. Hooks inherit
 * that environment, so a hook that blocks for rotation can leave a marker
 * at that path. The wrapper polls it: once it reads `ready`, it ends
 * claude and starts a fresh one with `/clauditor continue`.
 *
 * - UserPromptSubmit block → `ready` at once (claude is idle, prompt refused).
 * - PostToolUse block      → `pending`; Claude is still writing its handoff.
 *   The Stop hook flips it to `ready` when that turn ends.
 *
 * Outside `clauditor run` the env var is unset and all of this is a no-op.
 */
export const ROTATE_ENV = 'CLAUDITOR_ROTATE_FILE'

export interface RotateMarker {
  state: 'pending' | 'ready'
  sessionId: string
  cwd: string | null
  /** The prompt the UserPromptSubmit block refused, replayed after resume */
  prompt: string | null
  at: string
}

export function autoRotateFile(): string | null {
  return process.env[ROTATE_ENV] || null
}

export function readRotateMarker(path: string): RotateMarker | null {
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8'))
    if (m && (m.state === 'pending' || m.state === 'ready') && typeof m.sessionId === 'string') {
      return m as RotateMarker
    }
  } catch {}
  return null
}

function writeMarker(path: string, marker: RotateMarker): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, JSON.stringify(marker))
  renameSync(tmp, path)
}

/** Ask the wrapper to rotate. Returns false when not running under `clauditor run`. */
export function requestRotation(m: Omit<RotateMarker, 'at'>): boolean {
  const path = autoRotateFile()
  if (!path) return false
  try {
    writeMarker(path, { ...m, at: new Date().toISOString() })
    return true
  } catch {
    return false
  }
}

/** Stop hook: promote this session's `pending` marker to `ready`. */
export function markRotationReady(sessionId: string): boolean {
  const path = autoRotateFile()
  if (!path) return false
  const m = readRotateMarker(path)
  if (!m || m.state !== 'pending' || m.sessionId !== sessionId) return false
  try {
    writeMarker(path, { ...m, state: 'ready', at: new Date().toISOString() })
    return true
  } catch {
    return false
  }
}
