import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { logActivity } from '../features/activity-log.js'
import { ROTATE_ENV, readRotateMarker } from '../features/auto-rotate.js'
import type { RotateMarker } from '../features/auto-rotate.js'

const MIN_SESSION_MS = 5000 // a rotation <5s after launch looks like a loop — stop
const KILL_GRACE_MS = 5000  // SIGTERM → SIGKILL if claude hasn't exited

export interface RunOptions {
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
    args = [...opts.persistentArgs, continuePrompt(rotation.prompt)]

    console.log(`\n  clauditor: context limit reached — resuming in a fresh session (${restarts}/${opts.maxRestarts})...\n`)
    logActivity({
      type: 'auto_rotation',
      session: rotation.sessionId.slice(0, 8),
      message: `Auto-restarted session (${restarts}/${opts.maxRestarts})`,
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
  let maxRestarts = 10
  const persistentArgs: string[] = []
  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    if (a === '--max-restarts') { maxRestarts = parseInt(before[++i], 10) || 10; continue }
    if (a.startsWith('--max-restarts=')) { maxRestarts = parseInt(a.split('=')[1], 10) || 10; continue }
    persistentArgs.push(a)
  }
  return { maxRestarts, persistentArgs, firstArgs }
}

export function continuePrompt(refused: string | null): string {
  return refused ? `/clauditor continue ${refused}` : '/clauditor continue'
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
