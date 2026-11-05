import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { writeJsonFileAtomic } from '../hooks/shared.js'

/**
 * The prompt that started a chain of sessions, carried across resumes.
 *
 * A session resumed with `/clauditor continue` has no task of its own: its
 * first message is the resume command. Without this, its handoff's
 * "## Original Task" became whatever the user typed next (or nothing), so
 * by the second rotation the prompt that started the work was gone.
 *
 * When a session's prompt is `/clauditor continue`, the UserPromptSubmit
 * hook copies the Original Task out of the handoff being resumed and files
 * it under the new session's id. That session's own handoff then repeats
 * it, so every handoff in the chain names the first session's prompt.
 */

const ORIGINS_FILE = resolve(homedir(), '.clauditor', 'session-origins.json')
const KEEP_MS = 30 * 24 * 60 * 60 * 1000

/** Longest Original Task kept in a handoff. */
export const ORIGINAL_TASK_MAX = 2000

interface OriginEntry {
  task: string
  /** the handoff it was copied from */
  from: string | null
  at: string
}

/** A typed `/clauditor continue …` or `/clauditor resume …` prompt. */
export function isResumePrompt(prompt: string): boolean {
  return /^\s*\/clauditor\s+(continue|resume)\b/i.test(prompt)
}

/** The same command as Claude Code records it in a transcript. */
export function isResumeCommandMessage(text: string): boolean {
  if (!/<command-name>\/?clauditor<\/command-name>/.test(text)) return false
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
  return !!args && /^\s*(continue|resume)\b/i.test(args[1])
}

/** The "## Original Task" section of a handoff (up to the next heading). */
export function originalTaskFromHandoff(md: string): string | null {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.trim() === '## Original Task')
  if (start < 0) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break
    body.push(lines[i])
  }
  const task = body.join('\n').trim()
  return task || null
}

export function truncateTask(task: string): string {
  return task.length > ORIGINAL_TASK_MAX ? task.slice(0, ORIGINAL_TASK_MAX) + '...' : task
}

function readOrigins(file: string): Record<string, OriginEntry> {
  try {
    const o = JSON.parse(readFileSync(file, 'utf-8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

/** File a session's chain origin. The first one recorded for a session wins. */
export function recordSessionOrigin(
  sessionId: string,
  task: string,
  from: string | null,
  file: string = ORIGINS_FILE,
): boolean {
  if (!sessionId || !task.trim()) return false
  const all = readOrigins(file)
  if (all[sessionId]) return false
  const cutoff = Date.now() - KEEP_MS
  for (const [id, e] of Object.entries(all)) {
    if (!(Date.parse(e?.at) > cutoff)) delete all[id]
  }
  all[sessionId] = { task: truncateTask(task.trim()), from, at: new Date().toISOString() }
  try {
    writeJsonFileAtomic(file, all)
    return true
  } catch {
    return false
  }
}

export function readSessionOrigin(sessionId: string, file: string = ORIGINS_FILE): string | null {
  const task = readOrigins(file)[sessionId]?.task
  return typeof task === 'string' && task.trim() ? task : null
}
