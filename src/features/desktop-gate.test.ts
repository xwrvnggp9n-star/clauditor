import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Fresh module import per test so the mocked homedir is picked up
async function importFresh(tempDir: string) {
  vi.resetModules()
  vi.doMock('node:os', () => ({ homedir: () => tempDir }))
  return await import('./desktop-gate.js')
}

const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
const CLI = { CLAUDE_CODE_ENTRYPOINT: 'cli' }

describe('desktop app gate', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-desktop-gate-'))
  })

  afterEach(() => {
    vi.doUnmock('node:os')
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('never skips terminal or SDK sessions', async () => {
    const gate = await importFresh(tempDir)
    expect(gate.shouldSkipHook(CLI, { session_id: 'abc' })).toBe(false)
    expect(gate.shouldSkipHook({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, { session_id: 'abc' })).toBe(false)
    expect(gate.shouldSkipHook({}, { session_id: 'abc' })).toBe(false)
  })

  it('skips desktop sessions by default', async () => {
    const gate = await importFresh(tempDir)
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'abc' })).toBe(true)
    expect(gate.shouldSkipHook(DESKTOP, {})).toBe(true)
  })

  it('runs a desktop session once it is opted in, and stops again when opted out', async () => {
    const gate = await importFresh(tempDir)
    gate.enableSession('abc-123')
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'abc-123' })).toBe(false)
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'other' })).toBe(true)
    gate.disableSession('abc-123')
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'abc-123' })).toBe(true)
  })

  it('runs every desktop session when enabled globally, preserving other config', async () => {
    mkdirSync(join(tempDir, '.clauditor'), { recursive: true })
    writeFileSync(
      join(tempDir, '.clauditor', 'config.json'),
      JSON.stringify({ rotation: { contextBlockPct: 20 } }),
    )
    const gate = await importFresh(tempDir)
    gate.setGlobalEnabled(true)
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'abc' })).toBe(false)
    const saved = JSON.parse(readFileSync(join(tempDir, '.clauditor', 'config.json'), 'utf-8'))
    expect(saved.rotation.contextBlockPct).toBe(20)
    expect(saved.desktopApp.enabled).toBe(true)
    gate.setGlobalEnabled(false)
    expect(gate.shouldSkipHook(DESKTOP, { session_id: 'abc' })).toBe(true)
  })

  it('rejects session ids that could escape the markers directory', async () => {
    const gate = await importFresh(tempDir)
    expect(() => gate.enableSession('../config.json')).toThrow()
    expect(gate.isSessionEnabled('../config.json')).toBe(false)
  })

  it('falls back to the transcript entrypoint when the env var is missing', async () => {
    const gate = await importFresh(tempDir)
    const desktopTranscript = join(tempDir, 'desktop.jsonl')
    const cliTranscript = join(tempDir, 'cli.jsonl')
    writeFileSync(desktopTranscript, '{"type":"user","entrypoint":"claude-desktop"}\n')
    writeFileSync(cliTranscript, '{"type":"user","entrypoint":"cli"}\n')
    expect(gate.isDesktopSession({}, desktopTranscript)).toBe(true)
    expect(gate.isDesktopSession({}, cliTranscript)).toBe(false)
    expect(gate.isDesktopSession({}, join(tempDir, 'missing.jsonl'))).toBe(false)
    // The env var wins when present
    expect(gate.isDesktopSession(CLI, desktopTranscript)).toBe(false)
  })

  it('prunes opt-in markers older than 7 days', async () => {
    const gate = await importFresh(tempDir)
    gate.enableSession('old')
    gate.enableSession('fresh')
    const dir = join(tempDir, '.clauditor', 'desktop-sessions')
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(dir, 'old'), eightDaysAgo, eightDaysAgo)
    gate.pruneStaleDesktopMarkers()
    expect(existsSync(join(dir, 'old'))).toBe(false)
    expect(existsSync(join(dir, 'fresh'))).toBe(true)
  })
})
