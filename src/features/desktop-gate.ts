import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { readConfig, writeConfig } from '../config.js'

/**
 * Claude desktop app gate.
 *
 * The desktop app runs the same Claude Code binary as the terminal and loads
 * the same ~/.claude/settings.json hooks, so every clauditor hook fires there
 * too. Desktop sessions run with CLAUDE_CODE_ENTRYPOINT=claude-desktop
 * (terminal sessions get "cli"). In those sessions clauditor's hooks are
 * no-ops unless the user opted in, either for one session
 * (`clauditor desktop on`) or for every desktop session
 * (`clauditor desktop on --global`, i.e. desktopApp.enabled in config.json).
 */

const DESKTOP_ENTRYPOINT = 'claude-desktop'
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,128}$/
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const TRANSCRIPT_HEAD_BYTES = 64 * 1024

function sessionsDir(): string {
  return resolve(homedir(), '.clauditor', 'desktop-sessions')
}

/**
 * True when this process belongs to a Claude desktop app session.
 * The env var is authoritative when set; transcripts also record the
 * entrypoint on every message, which covers a hook env that lacks it.
 */
export function isDesktopSession(
  env: NodeJS.ProcessEnv,
  transcriptPath?: string,
): boolean {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT
  if (entrypoint) return entrypoint === DESKTOP_ENTRYPOINT
  if (!transcriptPath) return false
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return buf.toString('utf-8', 0, n).includes(`"entrypoint":"${DESKTOP_ENTRYPOINT}"`)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

export function isValidSessionId(sessionId: string | undefined): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId)
}

export function isSessionEnabled(sessionId: string | undefined): boolean {
  if (!isValidSessionId(sessionId)) return false
  return existsSync(resolve(sessionsDir(), sessionId))
}

export function enableSession(sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  mkdirSync(sessionsDir(), { recursive: true })
  writeFileSync(resolve(sessionsDir(), sessionId), '')
}

export function disableSession(sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  rmSync(resolve(sessionsDir(), sessionId), { force: true })
}

export function setGlobalEnabled(enabled: boolean): void {
  const config = readConfig()
  config.desktopApp = { ...config.desktopApp, enabled }
  writeConfig(config)
}

/**
 * Decide whether a hook invocation should be skipped. Only desktop sessions
 * are ever skipped; terminal and SDK sessions always run.
 */
export function shouldSkipHook(
  env: NodeJS.ProcessEnv,
  hookInput: { session_id?: string; transcript_path?: string },
): boolean {
  if (!isDesktopSession(env, hookInput.transcript_path)) return false
  if (readConfig().desktopApp.enabled) return false
  return !isSessionEnabled(hookInput.session_id)
}

/** Remove per-session opt-in markers older than 7 days. */
export function pruneStaleDesktopMarkers(now = Date.now()): void {
  const dir = sessionsDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = resolve(dir, name)
    try {
      if (now - statSync(path).mtimeMs > MARKER_MAX_AGE_MS) rmSync(path, { force: true })
    } catch {}
  }
}
