import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { logActivity } from '../features/activity-log.js'
import { ROTATE_ENV, readRotateMarker } from '../features/auto-rotate.js'
import type { RotateMarker } from '../features/auto-rotate.js'

const MIN_SESSION_MS = 5000 // a rotation <5s after launch looks like a loop — stop
const KILL_GRACE_MS = 5000  // SIGTERM → SIGKILL if claude hasn't exited

export interface RunOptions {
  /** Infinity (the default) means no cap; the crash-loop guard still applies */
  maxRestarts: number
  /** claude flags reused on every launch (before `--` on the command line) */
  persistentArgs: string[]
  /** first launch only — prompt, -w, --resume … (after `--`) */
  firstArgs: string[]
  /** where hooks leave the rotation marker (ROTATE_ENV) */
  markerPath: string
  pollMs?: number
  /** wait after `ready` before ending claude, so the hook output/handoff lands */
  settleMs?: number
  /** Claude Code transcript root, for carrying the session title across restarts */
  projectsDir?: string
}

export interface RunResult {
  exitCode: number
  restarts: number
  reason: 'normal_exit' | 'signal' | 'max_restarts' | 'crash_loop' | 'spawn_error'
}

let currentChild: ChildProcess | null = null

/**
 * Run `claude` with auto-restart on session rotation.
 *
 * When a clauditor hook blocks for rotation it leaves a `ready` marker
 * (see features/auto-rotate.ts). This ends that claude and starts a fresh
 * one in the same directory with `/clauditor continue`, replaying the
 * prompt the block refused.
 */
export async function runWithAutoRotation(opts: Omit<RunOptions, 'markerPath'>): Promise<void> {
  preflight()
  const markerPath = resolve(homedir(), '.clauditor', 'rotate', `${process.pid}.json`)

  // Ctrl+C belongs to claude (it shares our terminal); don't let it kill the wrapper.
  process.on('SIGINT', () => {})
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      currentChild?.kill(sig)
      rmSync(markerPath, { force: true })
      process.exit(0)
    })
  }

  const result = await runLoop({ ...opts, markerPath })
  rmSync(markerPath, { force: true })

  if (result.reason === 'max_restarts') {
    console.log(`\n  clauditor: max restarts (${opts.maxRestarts}) reached. Exiting.\n`)
  }

  process.exit(result.exitCode)
}

/**
 * Core loop — returns instead of calling process.exit, making it testable.
 */
export async function runLoop(opts: RunOptions): Promise<RunResult> {
  let restarts = 0
  let cwd = process.cwd()
  let args = [...opts.persistentArgs, ...opts.firstArgs]

  while (true) {
    rmSync(opts.markerPath, { force: true })
    const startTime = Date.now()

    const { code, signal, rotation } = await runClaude(args, cwd, opts)

    if (code === -1) {
      return { exitCode: 1, restarts, reason: 'spawn_error' }
    }

    // Anything but our own rotation kill is the user leaving — stop
    if (!rotation) {
      if (signal) return { exitCode: 0, restarts, reason: 'signal' }
      return { exitCode: code ?? 0, restarts, reason: 'normal_exit' }
    }

    resetTerminal()

    if (Date.now() - startTime < MIN_SESSION_MS) {
      console.error('\n  ✗ session rotated within seconds of starting — possible loop. Stopping.')
      return { exitCode: 1, restarts, reason: 'crash_loop' }
    }

    if (restarts >= opts.maxRestarts) {
      return { exitCode: 0, restarts, reason: 'max_restarts' }
    }

    restarts++
    if (rotation.cwd && existsSync(rotation.cwd)) cwd = rotation.cwd
    // Carry the outgoing session's title over. Without it Claude Code titles
    // the fresh session from `/clauditor continue`, and every rotated window
    // ends up named "Clauditor session handoff".
    const transcript = readTranscript(rotation.sessionId, opts.projectsDir)
    const title = hasNameFlag(opts.persistentArgs) || !transcript ? null : pickSessionTitle(transcript)
    // Carry the model, effort, ultracode and advisor over too, so a
    // mid-session /model, /effort or /advisor change survives the restart
    // instead of falling back to the launch flags or the settings defaults.
    const carried = transcript ? pickSessionCarryOver(transcript) : null
    args = [
      ...withCarryOver(opts.persistentArgs, carried),
      ...(title ? ['--name', title] : []),
      continuePrompt(rotation.prompt),
    ]

    const count = Number.isFinite(opts.maxRestarts) ? `${restarts}/${opts.maxRestarts}` : `${restarts}`
    console.log(`\n  clauditor: context limit reached — resuming in a fresh session (${count})...\n`)
    logActivity({
      type: 'auto_rotation',
      session: rotation.sessionId.slice(0, 8),
      message: `Auto-restarted session (${count})`,
    }).catch(() => {})
  }
}

/**
 * `clauditor run [--max-restarts n] <flags…> [-- <first-launch args…>]`
 * Flags before `--` go to every claude launch; args after it (a prompt, -w,
 * --resume) only to the first, since a restart resumes the same directory.
 */
export function parseRunArgs(argv: string[]): { maxRestarts: number; persistentArgs: string[]; firstArgs: string[] } {
  const sep = argv.indexOf('--')
  const before = sep === -1 ? argv : argv.slice(0, sep)
  const firstArgs = sep === -1 ? [] : argv.slice(sep + 1)
  // No cap by default: a long working day can rotate many times, and a cap
  // just strands the session at the context block. The <5s crash-loop guard
  // in runLoop is what stops a runaway. --max-restarts opts into a cap.
  let maxRestarts = Infinity
  const cap = (v: string | undefined) => { const n = parseInt(v ?? '', 10); return n > 0 ? n : Infinity }
  const persistentArgs: string[] = []
  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--max-restarts') { maxRestarts = cap(before[++i]); continue }
    if (a.startsWith('--max-restarts=')) { maxRestarts = cap(a.split('=')[1]); continue }
    persistentArgs.push(a)
  }
  return { maxRestarts, persistentArgs, firstArgs }
}

export function continuePrompt(refused: string | null): string {
  return refused ? `/clauditor continue ${refused}` : '/clauditor continue'
}

/** Titles Claude Code generates from the resume command itself; never worth keeping. */
const HANDOFF_TITLE = /clauditor\s+(session\s+)?(handoff|continue|resume)/i

function hasNameFlag(args: string[]): boolean {
  return args.some((a) => a === '-n' || a === '--name' || a.startsWith('--name='))
}

/**
 * Pick the title to carry over from a transcript's JSONL: the last
 * user-set title (`/rename`, `--name`) wins, then the last AI title.
 * Returns null for handoff-style titles so they never propagate.
 */
export function pickSessionTitle(jsonl: string): string | null {
  let custom: string | null = null
  let ai: string | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.includes('-title"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle
      else if (e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle
    } catch {}
  }
  for (const t of [custom, ai]) {
    const clean = t?.trim()
    if (clean && !HANDOFF_TITLE.test(clean)) return clean
  }
  return null
}

/** Find `<sessionId>.jsonl` under ~/.claude/projects and return its text. */
export function readTranscript(sessionId: string, projectsDir?: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null
  const root = projectsDir ?? resolve(homedir(), '.claude', 'projects')
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`)
      if (existsSync(file)) return readFileSync(file, 'utf-8')
    }
  } catch {}
  return null
}

/** Find `<sessionId>.jsonl` under ~/.claude/projects and read its title. */
export function sessionTitle(sessionId: string, projectsDir?: string): string | null {
  const t = readTranscript(sessionId, projectsDir)
  return t ? pickSessionTitle(t) : null
}

const MODEL_ID = /^[\w.\-]+(\[\w+\])?$/

/**
 * The model the session's own turns last ran on, from the transcript's model
 * identity attachments (Claude Code writes one at launch and whenever the
 * model changes). A slash command or skill with `model:` in its frontmatter
 * also writes one for its own turn, so identities inside a command turn are
 * skipped, apart from the launch identity when nothing came before it.
 * Returns null when none is found.
 */
export function pickSessionModel(jsonl: string): string | null {
  let model: string | null = null
  let inCommandTurn = false
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"identity"') && !line.includes('"type":"user"')) continue
    try {
      const e = JSON.parse(line)
      if (e.isSidechain) continue
      if (e.type === 'user' && !e.isMeta) {
        const c = e.message?.content
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c) && c.length && c.every((b: { type?: string }) => b?.type === 'text')
            ? c.map((b: { text?: string }) => b.text ?? '').join('')
            : null
        if (text !== null) inCommandTurn = text.includes('<command-name>')
        continue
      }
      if (e.type !== 'attachment' || e.attachment?.type !== 'model') continue
      const id = e.attachment.identity?.modelId
      if (typeof id !== 'string' || !MODEL_ID.test(id)) continue
      if (!inCommandTurn || model === null) model = id
    } catch {}
  }
  return model
}

/** args with any `<flag> x` / `<flag>=x` taken out. */
export function withoutFlag(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) { i++; continue }
    if (args[i].startsWith(flag + '=')) continue
    out.push(args[i])
  }
  return out
}

/** persistentArgs with any `--model x` / `--model=x` taken out. */
export function withoutModelFlag(args: string[]): string[] {
  return withoutFlag(args, '--model')
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** `claude-opus-5-5[1m]` and `claude-opus-5-5` are the same model for effort. */
const baseModel = (id: string) => id.replace(/\[\w+\]$/, '')

/** The main conversation's requests, not a subagent's or a side query's. */
const isMainThreadQuery = (src: unknown) =>
  typeof src === 'string' && (src === 'sdk' || src.startsWith('repl_main_thread'))

/**
 * The effort level the session last ran `model` at, from the transcript's
 * `api-request` records (Claude Code writes the request params, including
 * `output_config.effort`, for each main-thread call). A `/effort <level>`
 * typed after the last request wins, since nothing has used it yet.
 * Returns null when neither is found.
 */
export function pickSessionEffort(jsonl: string, model: string | null): string | null {
  let fromRequest: string | null = null
  let fromAnyRequest: string | null = null
  let fromCommand: string | null = null
  let requestLine = -1
  let commandLine = -1
  const lines = jsonl.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isRequest = line.includes('"api-request"')
    const isCommand = line.includes('local-command-stdout>Set effort level to')
    if (!isRequest && !isCommand) continue
    try {
      const e = JSON.parse(line)
      if (isRequest && e.type === 'api-request' && isMainThreadQuery(e.querySource)) {
        const effort = e.params?.output_config?.effort
        if (typeof effort !== 'string' || !EFFORT_LEVELS.has(effort)) continue
        fromAnyRequest = effort
        // A command's `model:` frontmatter can run a turn on another model
        if (model && baseModel(String(e.params?.model ?? '')) !== baseModel(model)) continue
        fromRequest = effort
        requestLine = i
      } else if (isCommand && e.type === 'user' && !e.isSidechain && typeof e.message?.content === 'string') {
        const m = e.message.content.match(/^<local-command-stdout>Set effort level to (\w+)/)
        if (m && EFFORT_LEVELS.has(m[1])) { fromCommand = m[1]; commandLine = i }
      }
    } catch {}
  }
  if (fromCommand && commandLine > requestLine) return fromCommand
  return fromRequest ?? (model ? null : fromAnyRequest)
}

/**
 * Whether ultracode was on when the session ended: the last
 * `ultra_effort_enter` / `ultra_effort_exit` record (Claude Code writes one
 * whenever it turns on or off, including at launch). Null if neither.
 */
export function pickSessionUltracode(jsonl: string): boolean | null {
  let on: boolean | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"ultra_effort_')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'attachment' || e.isSidechain) continue
      if (e.attachment?.type === 'ultra_effort_enter') on = true
      else if (e.attachment?.type === 'ultra_effort_exit') on = false
    } catch {}
  }
  return on
}

/**
 * The session's advisor, from the last `advisor_tool` record: the advisor
 * model when on, '' when it was turned off (an empty `advisorModel` turns
 * it off over the user's settings), null when unknown. `byBase` means only
 * that the current model can't use an advisor, so it says nothing about
 * whether the user wants one.
 */
export function pickSessionAdvisor(jsonl: string): string | null {
  let advisor: string | null = null
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"advisor_tool"')) continue
    try {
      const e = JSON.parse(line)
      const a = e.attachment
      if (e.type !== 'attachment' || e.isSidechain || a?.type !== 'advisor_tool') continue
      if (a.available === true && typeof a.model === 'string' && MODEL_ID.test(a.model)) advisor = a.model
      else if (a.available === false && !a.byBase) advisor = ''
    } catch {}
  }
  return advisor
}

export interface CarryOver {
  model: string | null
  effort: string | null
  ultracode: boolean | null
  advisor: string | null
}

/** Everything a restart carries over from the outgoing session's transcript. */
export function pickSessionCarryOver(jsonl: string): CarryOver {
  const model = pickSessionModel(jsonl)
  return {
    model,
    effort: pickSessionEffort(jsonl, model),
    ultracode: pickSessionUltracode(jsonl),
    advisor: pickSessionAdvisor(jsonl),
  }
}

/**
 * persistentArgs with the carried-over state applied: `--model` and
 * `--effort` replace any given at launch; ultracode and the advisor go in
 * one `--settings` JSON, merged over any `--settings` given at launch
 * (inline JSON or a file). If that one can't be read, it's kept as is and
 * the two settings aren't carried, rather than passing --settings twice.
 */
export function withCarryOver(persistentArgs: string[], c: CarryOver | null): string[] {
  if (!c) return persistentArgs
  let args = persistentArgs
  if (c.model) args = [...withoutFlag(args, '--model'), '--model', c.model]
  if (c.effort) args = [...withoutFlag(args, '--effort'), '--effort', c.effort]
  const settings: Record<string, unknown> = {}
  if (c.ultracode !== null) settings.ultracode = c.ultracode
  if (c.advisor !== null) settings.advisorModel = c.advisor
  return withSettings(args, settings)
}

export function withSettings(args: string[], extra: Record<string, unknown>): string[] {
  if (Object.keys(extra).length === 0) return args
  const rest: string[] = []
  let base: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i++) {
    let value: string | undefined
    if (args[i] === '--settings') value = args[++i]
    else if (args[i].startsWith('--settings=')) value = args[i].slice('--settings='.length)
    else { rest.push(args[i]); continue }
    const parsed = value === undefined ? null : readSettingsArg(value)
    if (!parsed) return args
    base = { ...base, ...parsed }
  }
  return [...rest, '--settings', JSON.stringify({ ...base, ...extra })]
}

function readSettingsArg(value: string): Record<string, unknown> | null {
  try {
    const text = value.trim().startsWith('{') ? value : readFileSync(value, 'utf-8')
    const o = JSON.parse(text)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

/**
 * Spawn claude and watch the marker. On `ready`, end claude (SIGTERM, then
 * SIGKILL) and report the marker so the loop restarts.
 */
function runClaude(
  args: string[],
  cwd: string,
  opts: RunOptions,
): Promise<{ code: number | null; signal: string | null; rotation: RotateMarker | null }> {
  return new Promise((done) => {
    let rotation: RotateMarker | null = null
    const timers: NodeJS.Timeout[] = []

    const child = spawn('claude', args, {
      stdio: 'inherit',
      cwd,
      env: { ...process.env, [ROTATE_ENV]: opts.markerPath },
    })
    currentChild = child

    const poll = setInterval(() => {
      if (rotation) return
      const m = readRotateMarker(opts.markerPath)
      if (m?.state !== 'ready') return
      rotation = m
      timers.push(setTimeout(() => child.kill('SIGTERM'), opts.settleMs ?? 1500))
      timers.push(setTimeout(() => child.kill('SIGKILL'), (opts.settleMs ?? 1500) + KILL_GRACE_MS))
    }, opts.pollMs ?? 500)

    const finish = (r: { code: number | null; signal: string | null }) => {
      clearInterval(poll)
      timers.forEach(clearTimeout)
      currentChild = null
      done({ ...r, rotation })
    }

    child.on('error', (err) => {
      console.error(`\n  ✗ Failed to spawn claude: ${err.message}`)
      finish({ code: -1, signal: null })
    })
    child.on('exit', (code, signal) => finish({ code, signal }))
  })
}

/** A killed TUI can leave raw mode / hidden cursor / paste+mouse modes on. */
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try { execSync('stty sane', { stdio: 'inherit' }) } catch {}
  process.stdout.write('\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l')
}

/**
 * Preflight checks — run once before the loop.
 */
function preflight(): void {
  try {
    execSync('which claude', { stdio: 'ignore' })
  } catch {
    console.error('\n  ✗ `claude` CLI not found in PATH.')
    console.error('    Install it first: https://docs.anthropic.com/en/docs/claude-code')
    process.exit(1)
  }

  const settingsPath = resolve(homedir(), '.claude', 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      const hasClauditorHooks = JSON.stringify(settings.hooks || {}).includes('clauditor hook')
      if (!hasClauditorHooks) {
        console.log('\n  ⚠ clauditor hooks not detected in ~/.claude/settings.json')
        console.log('    Auto-rotation requires hooks. Run `clauditor install` first.\n')
      }
    } catch {}
  } else {
    console.log('\n  ⚠ ~/.claude/settings.json not found — hooks may not be installed.')
    console.log('    Run `clauditor install` to set up hooks.\n')
  }
}
