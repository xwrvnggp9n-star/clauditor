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

import {
  runLoop, parseRunArgs, continuePrompt, pickSessionTitle, sessionTitle, pickSessionModel, withoutModelFlag,
  pickSessionEffort, pickSessionUltracode, pickSessionAdvisor, pickSessionCarryOver, withCarryOver, withSettings,
} from './run.js'
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

  it('carries the model the outgoing session last used, replacing a launch --model', async () => {
    slowClock()
    mkdirSync(join(dir, 'projects', '-proj'), { recursive: true })
    const ident = (id: string) => JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: id } } })
    writeFileSync(join(dir, 'projects', '-proj', 'abcdef1234.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ident('claude-sonnet-5-5'),
      JSON.stringify({ type: 'user', message: { content: 'switch done' } }),
      ident('claude-opus-5-5'),
    ].join('\n') + '\n')
    mockSpawn
      .mockImplementationOnce(() => fakeClaude({ onStart: () => writeReady() }))
      .mockImplementationOnce(() => fakeClaude({ exitAfterMs: 0 }))

    await runLoop(base({ persistentArgs: ['--model', 'sonnet', '--chrome'] }))

    const [, args] = mockSpawn.mock.calls[1]
    expect(args).toEqual(['--chrome', '--model', 'claude-opus-5-5', '/clauditor continue'])
  })

  it('carries effort, ultracode and the advisor, merged over a launch --settings', async () => {
    slowClock()
    mkdirSync(join(dir, 'projects', '-proj'), { recursive: true })
    writeFileSync(join(dir, 'projects', '-proj', 'abcdef1234.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5' } } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'ultra_effort_enter' } }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'advisor_tool', available: true, model: 'claude-fable-5-1' } }),
      JSON.stringify({ type: 'api-request', querySource: 'repl_main_thread', params: { model: 'claude-opus-5-5', output_config: { effort: 'max' } } }),
    ].join('\n') + '\n')
    mockSpawn
      .mockImplementationOnce(() => fakeClaude({ onStart: () => writeReady() }))
      .mockImplementationOnce(() => fakeClaude({ exitAfterMs: 0 }))

    await runLoop(base({ persistentArgs: ['--effort', 'low', '--settings', '{"theme":"dark"}', '--chrome'] }))

    const [, args] = mockSpawn.mock.calls[1]
    expect(args).toEqual([
      '--chrome', '--model', 'claude-opus-5-5', '--effort', 'max',
      '--settings', JSON.stringify({ theme: 'dark', ultracode: true, advisorModel: 'claude-fable-5-1' }),
      '/clauditor continue',
    ])
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

describe('pickSessionModel', () => {
  const ident = (id: string, extra: object = {}) =>
    JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: id } }, ...extra })
  const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: 'user', message: { content }, ...extra })

  it('returns the last identity of a normal turn (a /model switch)', () => {
    const j = [user('a'), ident('claude-opus-5-5'), user('b'), ident('claude-fable-5-1')].join('\n')
    expect(pickSessionModel(j)).toBe('claude-fable-5-1')
  })

  it('skips the model a slash command forces for its own turn', () => {
    const j = [
      user('<command-message>clauditor</command-message>\n<command-name>/clauditor</command-name>'),
      ident('claude-opus-5-5'),
      user([{ type: 'text', text: 'skill body' }], { isMeta: true }),
      user([{ type: 'tool_result', content: 'x' }]),
      ident('claude-sonnet-5-5'),
    ].join('\n')
    expect(pickSessionModel(j)).toBe('claude-opus-5-5')
  })

  it('takes the model back up on the next normal turn', () => {
    const j = [
      user('<command-name>/x</command-name>'), ident('claude-opus-5-5'), ident('claude-sonnet-5-5'),
      user('open the file'), ident('claude-opus-5-5'),
    ].join('\n')
    expect(pickSessionModel(j)).toBe('claude-opus-5-5')
  })

  it('ignores sidechains, junk and unsafe ids; null when there is none', () => {
    expect(pickSessionModel([ident('claude-opus-5-5'), ident('claude-haiku-5-5', { isSidechain: true })].join('\n'))).toBe('claude-opus-5-5')
    expect(pickSessionModel(ident('x; rm -rf /'))).toBeNull()
    expect(pickSessionModel('not json "identity"\n{"type":"user"}')).toBeNull()
  })
})

describe('withoutModelFlag', () => {
  it('drops both --model forms', () => {
    expect(withoutModelFlag(['--model', 'opus', '--chrome', '--model=sonnet', '-w'])).toEqual(['--chrome', '-w'])
  })
})

const req = (effort: string, extra: object = {}, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'api-request', querySource: 'repl_main_thread:outputStyle:Concise', params: { model, output_config: { effort } }, ...extra })
const effortCmd = (level: string, extra: object = {}) =>
  JSON.stringify({ type: 'user', message: { content: `<local-command-stdout>Set effort level to ${level} (this session only)</local-command-stdout>` }, ...extra })
const att = (attachment: object, extra: object = {}) => JSON.stringify({ type: 'attachment', attachment, ...extra })

describe('pickSessionEffort', () => {
  it('takes the last main-thread request for the carried model', () => {
    expect(pickSessionEffort([req('high'), req('max')].join('\n'), 'claude-opus-5-5')).toBe('max')
    expect(pickSessionEffort(req('xhigh', { querySource: 'sdk' }), 'claude-opus-5-5')).toBe('xhigh')
  })

  it('ignores subagent and side-query requests', () => {
    const j = [req('high'), req('low', { querySource: 'agent:custom' }), req('low', { querySource: 'compact' })].join('\n')
    expect(pickSessionEffort(j, 'claude-opus-5-5')).toBe('high')
  })

  it('skips a turn a command ran on another model; [1m] is the same model', () => {
    const j = [req('xhigh', {}, 'claude-opus-5-5[1m]'), req('low', {}, 'claude-haiku-5-5')].join('\n')
    expect(pickSessionEffort(j, 'claude-opus-5-5')).toBe('xhigh')
    expect(pickSessionEffort(req('low', {}, 'claude-haiku-5-5'), 'claude-opus-5-5')).toBeNull()
  })

  it('a /effort typed after the last request wins; one before it does not', () => {
    expect(pickSessionEffort([req('high'), effortCmd('max')].join('\n'), 'claude-opus-5-5')).toBe('max')
    expect(pickSessionEffort([effortCmd('max'), req('high')].join('\n'), 'claude-opus-5-5')).toBe('high')
    expect(pickSessionEffort(effortCmd('max', { isSidechain: true }), 'claude-opus-5-5')).toBeNull()
  })

  it('with no carried model, takes any main-thread request', () => {
    expect(pickSessionEffort(req('medium', {}, 'claude-haiku-5-5'), null)).toBe('medium')
  })

  it('ignores unknown levels and junk; null when there is none', () => {
    expect(pickSessionEffort([req('ultra'), 'not json "api-request"'].join('\n'), 'claude-opus-5-5')).toBeNull()
    expect(pickSessionEffort('', null)).toBeNull()
  })
})

describe('pickSessionUltracode', () => {
  it('follows the last enter/exit record', () => {
    expect(pickSessionUltracode([att({ type: 'ultra_effort_enter' }), att({ type: 'ultra_effort_exit' })].join('\n'))).toBe(false)
    expect(pickSessionUltracode([att({ type: 'ultra_effort_exit' }), att({ type: 'ultra_effort_enter' })].join('\n'))).toBe(true)
  })

  it('ignores sidechains; null when there is none', () => {
    expect(pickSessionUltracode(att({ type: 'ultra_effort_enter' }, { isSidechain: true }))).toBeNull()
    expect(pickSessionUltracode(req('high'))).toBeNull()
  })
})

describe('pickSessionAdvisor', () => {
  it('returns the advisor model when on, and the last record wins', () => {
    const on = att({ type: 'advisor_tool', available: true, model: 'claude-fable-5-1' })
    const off = att({ type: 'advisor_tool', available: false })
    expect(pickSessionAdvisor(on)).toBe('claude-fable-5-1')
    expect(pickSessionAdvisor([on, off].join('\n'))).toBe('')
    expect(pickSessionAdvisor([off, on].join('\n'))).toBe('claude-fable-5-1')
  })

  it('a byBase record (model cannot use one) says nothing', () => {
    const on = att({ type: 'advisor_tool', available: true, model: 'claude-fable-5-1' })
    expect(pickSessionAdvisor([on, att({ type: 'advisor_tool', available: false, byBase: true })].join('\n'))).toBe('claude-fable-5-1')
    expect(pickSessionAdvisor(att({ type: 'advisor_tool', available: false, byBase: true }))).toBeNull()
  })

  it('ignores sidechains and unsafe model ids', () => {
    expect(pickSessionAdvisor(att({ type: 'advisor_tool', available: true, model: 'claude-fable-5-1' }, { isSidechain: true }))).toBeNull()
    expect(pickSessionAdvisor(att({ type: 'advisor_tool', available: true, model: 'x; rm -rf /' }))).toBeNull()
  })
})

describe('pickSessionCarryOver', () => {
  it('collects all four, effort matched to the carried model', () => {
    const j = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      att({ type: 'model', identity: { modelId: 'claude-opus-5-5' } }),
      req('xhigh'), att({ type: 'ultra_effort_exit' }), att({ type: 'advisor_tool', available: false }),
    ].join('\n')
    expect(pickSessionCarryOver(j)).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh', ultracode: false, advisor: '' })
  })
})

describe('withCarryOver', () => {
  const none = { model: null, effort: null, ultracode: null, advisor: null }

  it('leaves args alone with nothing to carry', () => {
    const args = ['--model', 'opus', '--chrome']
    expect(withCarryOver(args, null)).toBe(args)
    expect(withCarryOver(args, none)).toEqual(args)
  })

  it('replaces --model and --effort in either form', () => {
    expect(withCarryOver(['--model=sonnet', '--effort', 'low', '-w'], { ...none, model: 'claude-opus-5-5', effort: 'max' }))
      .toEqual(['-w', '--model', 'claude-opus-5-5', '--effort', 'max'])
  })

  it('carries ultracode off and the advisor off as explicit settings', () => {
    expect(withCarryOver([], { ...none, ultracode: false, advisor: '' }))
      .toEqual(['--settings', JSON.stringify({ ultracode: false, advisorModel: '' })])
  })
})

describe('withSettings', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'clauditor-settings-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('adds one --settings when there is none', () => {
    expect(withSettings(['-w'], { ultracode: true })).toEqual(['-w', '--settings', '{"ultracode":true}'])
  })

  it('merges over inline JSON in either form, the carried value winning', () => {
    expect(withSettings(['--settings={"ultracode":false,"theme":"dark"}', '-w'], { ultracode: true }))
      .toEqual(['-w', '--settings', '{"ultracode":true,"theme":"dark"}'])
  })

  it('merges over a settings file', () => {
    const f = join(tmp, 's.json')
    writeFileSync(f, '{"model":"opus"}')
    expect(withSettings(['--settings', f], { advisorModel: 'claude-fable-5-1' }))
      .toEqual(['--settings', '{"model":"opus","advisorModel":"claude-fable-5-1"}'])
  })

  it('keeps the user\'s flag untouched when it cannot be read', () => {
    const args = ['--settings', join(tmp, 'missing.json'), '-w']
    expect(withSettings(args, { ultracode: true })).toBe(args)
    const bad = ['--settings', '{not json', '-w']
    expect(withSettings(bad, { ultracode: true })).toBe(bad)
    const arr = ['--settings', '[1]']
    expect(withSettings(arr, { ultracode: true })).toBe(arr)
  })

  it('does nothing with no extra settings', () => {
    const args = ['--settings', '{not json']
    expect(withSettings(args, {})).toBe(args)
  })
})
