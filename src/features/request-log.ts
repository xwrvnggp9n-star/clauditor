import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { isResumePrompt, readSessionRoot } from './session-origin.js'

/**
 * The verbatim log of everything the user asked in a chain of sessions.
 *
 * A handoff is a summary, and a summary of a hundred turns keeps the code
 * and drops the asks: by the second rotation, a request the user made in
 * passing ("and put a vCard icon next to it") exists nowhere the next
 * session can see. This log is the fix on the mechanical side. The
 * UserPromptSubmit hook appends every prompt the moment it arrives, so the
 * log survives a session that dies mid-task, and it is keyed by the chain's
 * root session, so it follows the work across every `/clauditor continue`.
 *
 * One JSON object per line: { at, session, prompt }. Lives beside the
 * project's handoffs:
 *   ~/.clauditor/sessions/<encoded-cwd>/requests-<chain-root>.jsonl
 */

/** Longest prompt kept verbatim, per entry. */
export const REQUEST_MAX = 4000
/** Longest prompt quoted inline in a handoff. */
export const REQUEST_INLINE_MAX = 600

export interface RequestEntry {
  at: string
  session: string
  prompt: string
}

/** Same encoding as session-state's handoff directory. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 100)
}

function sessionsDir(): string {
  return resolve(homedir(), '.clauditor', 'sessions')
}

/** The chain a session belongs to: the root recorded on resume, else itself. */
export function chainRootFor(sessionId: string): string {
  return readSessionRoot(sessionId) ?? sessionId
}

export function requestLogPath(cwd: string, chainRoot: string): string {
  return resolve(sessionsDir(), encodeCwd(cwd), `requests-${chainRoot.replace(/[^a-zA-Z0-9_-]/g, '')}.jsonl`)
}

/**
 * The part of a prompt that is a request. A `/clauditor continue <text>`
 * carries the message the previous session refused; other `/clauditor`
 * commands are plumbing and return null.
 */
export function requestFromPrompt(prompt: string): string | null {
  const p = prompt.trim()
  if (!p) return null
  if (isResumePrompt(p)) {
    const rest = p.replace(/^\s*\/clauditor\s+(continue|resume)\b/i, '').trim()
    return rest || null
  }
  if (/^\/clauditor\b/i.test(p)) return null
  return p
}

/** Append one prompt to the chain's log. Never throws; returns the path written, or null. */
export function appendRequest(opts: {
  cwd: string | null | undefined
  sessionId: string
  prompt: string | null | undefined
  at?: Date
}): string | null {
  try {
    if (!opts.cwd || !opts.sessionId || !opts.prompt) return null
    const request = requestFromPrompt(opts.prompt)
    if (!request) return null
    const path = requestLogPath(opts.cwd, chainRootFor(opts.sessionId))
    mkdirSync(resolve(path, '..'), { recursive: true })
    const entry: RequestEntry = {
      at: (opts.at ?? new Date()).toISOString(),
      session: opts.sessionId,
      prompt: request.length > REQUEST_MAX ? request.slice(0, REQUEST_MAX) + '…' : request,
    }
    appendFileSync(path, JSON.stringify(entry) + '\n')
    return path
  } catch {
    return null
  }
}

export function readRequestLog(path: string): RequestEntry[] {
  try {
    if (!existsSync(path)) return []
    const out: RequestEntry[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e.prompt === 'string') out.push(e)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

/** The handoff's pointer to the chain log: path and how many requests it holds, or null when there is none. */
export function requestLogSummary(cwd: string | null, sessionId: string | null): { path: string; count: number } | null {
  if (!cwd || !sessionId) return null
  const path = requestLogPath(cwd, chainRootFor(sessionId))
  const count = readRequestLog(path).length
  return count > 0 ? { path, count } : null
}

/** One prompt as it is quoted in a handoff: one line, capped. */
export function inlineRequest(prompt: string): string {
  const flat = prompt.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return flat.length > REQUEST_INLINE_MAX ? flat.slice(0, REQUEST_INLINE_MAX) + '…' : flat
}
