import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock child_process.spawn
const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: () => Buffer.from('/usr/bin/claude'),
}))

// Mock activity log — must return a thenable
vi.mock('../features/activity-log.js', () => ({
  logActivity: () => Promise.resolve(),
}))

import { runLoop, parseRunArgs, continuePrompt, pickSessionTitle, sessionTitle } from './run.js'
import type { RunOptions } from './run.js'

type FakeChild = EventEmitter & { kill: (sig: string) => void; killedWith: string[] }

/** A claude that runs until killed, or exits by itself after `exitAfterMs`. */
function fakeClaude(opts: { exitCode?: number | null; signal?: string | null; exitAfterMs?: number; onStart?: () => void } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.killedWith = []
  child.kill = (sig: string) => {
    child.killedWith.push(sig)
    setTimeout(() => child.emit('exit', null, sig), 0)
  }
  setTimeout(() => opts.onStart?.(), 0)
  if (opts.exitAfterMs !== undefined) {
    setTimeout(() => child.emit('exit', opts.exitCode ?? 0, opts.signal ?? null), opts.exitAfterMs)
  }
  return child
}

let dir: string
let marker: string

function base(extra: Partial<RunOptions> = {}): RunOptions {
  return {
    maxRestarts: 3,
    persistentArgs: ['--dangerously-skip-permissions', '--chrome'],
    firstArgs: ['-w', 'fix the bug'],
    markerPath: marker,
    projectsDir: join(dir, 'projects'),
    pollMs: 5,
    settleMs: 5,
    ...extra,
  }
}

function writeReady(m: Record<string, unknown> = {}) {
  writeFileSync(marker, JSON.stringify({ state: 'ready', sessionId: 'abcdef1234', cwd: dir, prompt: null, at: 'x', ...m }))
}

// Date.now advances 10s per call, so no run looks like a crash loop
function slowClock() {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 10000))
}

describe('runLoop', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
    vi.restoreAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'clauditor-run-'))
    marker = join(dir, 'rotate.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exits cleanly when claude exits with code 0', async () => {
    mockSpawn.mockReturnValue(fakeClaude({ exitAfterMs: 0 }))
    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 0, restarts: 0, reason: 'normal_exit' })
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('first launch gets persistent + first-only args and the marker env', async () => {
    mockSpawn.mockReturnValue(fakeClaude({ exitAfterMs: 0 }))
    await runLoop(base())

    const [cmd, args, spawnOpts] = mockSpawn.mock.calls[0]
    expect(cmd).toBe('claude')
    expect(args).toEqual(['--dangerously-skip-permissions', '--chrome', '-w', 'fix the bug'])
    expect(spawnOpts.env.CLAUDITOR_ROTATE_FILE).toBe(marker)
  })

  it('stops when claude is killed by a signal it did not get from us', async () => {
    mockSpawn.mockReturnValue(fakeClaude({ exitCode: null, signal: 'SIGTERM', exitAfterMs: 0 }))
    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 0, restarts: 0, reason: 'signal' })
  })

  it('forwards a nonzero exit code — exit code 2 alone no longer restarts', async () => {
    mockSpawn.mockReturnValue(fakeClaude({ exitCode: 2, exitAfterMs: 0 }))
    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 2, restarts: 0, reason: 'normal_exit' })
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('on a ready marker: ends claude and resumes in the marker cwd, replaying the refused prompt', async () => {
    slowClock()
    let first!: FakeChild
    mockSpawn
      .mockImplementationOnce(() => (first = fakeClaude({ onStart: () => writeReady({ prompt: 'now add tests' }) })))
      .mockImplementationOnce(() => fakeClaude({ exitAfterMs: 0 }))

    const result = await runLoop(base())

    expect(first.killedWith).toEqual(['SIGTERM'])
    expect(result).toEqual({ exitCode: 0, restarts: 1, reason: 'normal_exit' })
    const [, args, spawnOpts] = mockSpawn.mock.calls[1]
    // -w and the original prompt are NOT repeated; the worktree is reopened via cwd
    expect(args).toEqual(['--dangerously-skip-permissions', '--chrome', '/clauditor continue now add tests'])
    expect(spawnOpts.cwd).toBe(dir)
  })

  it('carries the outgoing session title over with --name', async () => {
    slowClock()
    mkdirSync(join(dir, 'projects', '-proj'), { recursive: true })
    writeFileSync(join(dir, 'projects', '-proj', 'abcdef1234.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'History tab win/loss KPIs', sessionId: 'abcdef1234' }) + '\n')
    mockSpawn
      .mockImplementationOnce(() => fakeClaude({ onStart: () => writeReady() }))
      .mockImplementationOnce(() => fakeClaude({ exitAfterMs: 0 }))

    await runLoop(base())

    const [, args] = mockSpawn.mock.calls[1]
    expect(args).toEqual(['--dangerously-skip-permissions', '--chrome', '--name', 'History tab win/loss KPIs', '/clauditor continue'])
  })

  it('does not add --name when the user already passed one', async () => {
    slowClock()
    mkdirSync(join(dir, 'projects', '-proj'), { recursive: true })
    writeFileSync(join(dir, 'projects', '-proj', 'abcdef1234.jsonl'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Something', sessionId: 'abcdef1234' }) + '\n')
    mockSpawn
      .mockImplementationOnce(() => fakeClaude({ onStart: () => writeReady() }))
      .mockImplementationOnce(() => fakeClaude({ exitAfterMs: 0 }))

    await runLoop(base({ persistentArgs: ['--name', 'Mine'] }))

    const [, args] = mockSpawn.mock.calls[1]
    expect(args).toEqual(['--name', 'Mine', '/clauditor continue'])
  })

  it('does not act on a pending marker (Claude still writing its handoff)', async () => {
    mockSpawn.mockReturnValue(fakeClaude({
      exitAfterMs: 60,
      onStart: () => writeFileSync(marker, JSON.stringify({ state: 'pending', sessionId: 's', cwd: null, prompt: null, at: 'x' })),
    }))
    const result = await runLoop(base())

    expect(result.reason).toBe('normal_exit')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('clears a stale marker before launching', async () => {
    writeReady()
    mockSpawn.mockReturnValue(fakeClaude({ exitAfterMs: 40 }))
    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 0, restarts: 0, reason: 'normal_exit' })
  })

  it('stops after max restarts', async () => {
    slowClock()
    mockSpawn.mockImplementation(() => fakeClaude({ onStart: () => writeReady() }))

    const result = await runLoop(base({ maxRestarts: 2 }))

    expect(result).toEqual({ exitCode: 0, restarts: 2, reason: 'max_restarts' })
    expect(mockSpawn).toHaveBeenCalledTimes(3) // 1 initial + 2 restarts
  })

  it('keeps restarting past 10 when uncapped, then stops when claude exits', async () => {
    slowClock()
    let launches = 0
    mockSpawn.mockImplementation(() => {
      launches++
      return launches <= 12 ? fakeClaude({ onStart: () => writeReady() }) : fakeClaude({ exitAfterMs: 0 })
    })

    const result = await runLoop(base({ maxRestarts: Infinity }))

    expect(result).toEqual({ exitCode: 0, restarts: 12, reason: 'normal_exit' })
  })

  it('treats a rotation within seconds of launch as a loop and stops', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    mockSpawn.mockImplementation(() => fakeClaude({ onStart: () => writeReady() }))

    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 1, restarts: 0, reason: 'crash_loop' })
    expect(mockSpawn).toHaveBeenCalledTimes(1)
  })

  it('handles spawn error gracefully', async () => {
    const child = new EventEmitter()
    mockSpawn.mockReturnValue(child)
    setTimeout(() => child.emit('error', new Error('ENOENT')), 0)

    const result = await runLoop(base())

    expect(result).toEqual({ exitCode: 1, restarts: 0, reason: 'spawn_error' })
  })
})

describe('parseRunArgs', () => {
  it('splits persistent flags from first-launch args at --', () => {
    expect(parseRunArgs(['--dangerously-skip-permissions', '--chrome', '--', '-w', 'do X'])).toEqual({
      maxRestarts: Infinity,
      persistentArgs: ['--dangerously-skip-permissions', '--chrome'],
      firstArgs: ['-w', 'do X'],
    })
  })

  it('takes --max-restarts for itself, in either form', () => {
    expect(parseRunArgs(['--max-restarts', '4', '--chrome']).maxRestarts).toBe(4)
    expect(parseRunArgs(['--max-restarts=6']).maxRestarts).toBe(6)
    expect(parseRunArgs(['--max-restarts', '4', '--chrome']).persistentArgs).toEqual(['--chrome'])
  })

  it('has no restart cap unless one is asked for', () => {
    expect(parseRunArgs([]).maxRestarts).toBe(Infinity)
    expect(parseRunArgs(['--max-restarts', 'x']).maxRestarts).toBe(Infinity)
    expect(parseRunArgs(['--max-restarts=0']).maxRestarts).toBe(Infinity)
  })

  it('leaves --max-restarts after -- alone', () => {
    expect(parseRunArgs(['--', '--max-restarts', '4']).firstArgs).toEqual(['--max-restarts', '4'])
  })
})

describe('continuePrompt', () => {
  it('appends the refused prompt when there is one', () => {
    expect(continuePrompt(null)).toBe('/clauditor continue')
    expect(continuePrompt('ship it')).toBe('/clauditor continue ship it')
  })
})

describe('pickSessionTitle', () => {
  const line = (o: object) => JSON.stringify(o)

  it('prefers the last custom title over the AI title', () => {
    const j = [
      line({ type: 'ai-title', aiTitle: 'AI one' }),
      line({ type: 'custom-title', customTitle: 'Old name' }),
      line({ type: 'custom-title', customTitle: 'Renamed' }),
      line({ type: 'ai-title', aiTitle: 'AI two' }),
    ].join('\n')
    expect(pickSessionTitle(j)).toBe('Renamed')
  })

  it('falls back to the last AI title', () => {
    const j = [line({ type: 'ai-title', aiTitle: 'First' }), line({ type: 'ai-title', aiTitle: 'Second' })].join('\n')
    expect(pickSessionTitle(j)).toBe('Second')
  })

  it('never carries a handoff-style title', () => {
    expect(pickSessionTitle(line({ type: 'ai-title', aiTitle: 'Clauditor session handoff' }))).toBeNull()
    expect(pickSessionTitle(line({ type: 'ai-title', aiTitle: 'Clauditor session handoff and resume' }))).toBeNull()
    expect(pickSessionTitle([
      line({ type: 'custom-title', customTitle: 'Clauditor session handoff' }),
      line({ type: 'ai-title', aiTitle: 'Real work' }),
    ].join('\n'))).toBe('Real work')
  })

  it('ignores junk lines and returns null with no title', () => {
    expect(pickSessionTitle('not json -title"\n{"type":"user"}')).toBeNull()
  })
})

describe('sessionTitle', () => {
  it('returns null for a missing transcript or an unsafe id', () => {
    const d = mkdtempSync(join(tmpdir(), 'clauditor-title-'))
    try {
      expect(sessionTitle('nope', d)).toBeNull()
      expect(sessionTitle('../x', d)).toBeNull()
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
