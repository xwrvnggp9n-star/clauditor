import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROTATE_ENV, requestRotation, markRotationReady, readRotateMarker, manualRestartSteps, notWrappedWarning, shellQuote, DEFAULT_RESUME_COMMAND } from './auto-rotate.js'

let dir: string
let marker: string

describe('auto-rotate marker', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clauditor-rot-'))
    marker = join(dir, 'sub', 'm.json')
    process.env[ROTATE_ENV] = marker
  })
  afterEach(() => {
    delete process.env[ROTATE_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a no-op outside `clauditor run`', () => {
    delete process.env[ROTATE_ENV]
    expect(requestRotation({ state: 'ready', sessionId: 's1', cwd: null, prompt: null })).toBe(false)
    expect(markRotationReady('s1')).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('writes a ready marker with the refused prompt', () => {
    expect(requestRotation({ state: 'ready', sessionId: 's1', cwd: '/w', prompt: 'hi' })).toBe(true)
    expect(readRotateMarker(marker)).toMatchObject({ state: 'ready', sessionId: 's1', cwd: '/w', prompt: 'hi' })
  })

  it('Stop promotes pending → ready for the same session only', () => {
    requestRotation({ state: 'pending', sessionId: 's1', cwd: null, prompt: null })
    expect(markRotationReady('other')).toBe(false)
    expect(readRotateMarker(marker)?.state).toBe('pending')
    expect(markRotationReady('s1')).toBe(true)
    expect(readRotateMarker(marker)?.state).toBe('ready')
  })

  it('Stop without a pending marker does nothing', () => {
    expect(markRotationReady('s1')).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('manual restart steps (outside `clauditor run`)', () => {
  const wt = '/Users/x/Projects/App/.claude/worktrees/steady-prancing-conway'

  it('says exactly what to type: /exit, cd into the session dir, then the resume command', () => {
    const out = manualRestartSteps(wt, 'domc "/clauditor continue"')
    expect(out).toContain('1. Type /exit')
    expect(out.split('\n').slice(-2)).toEqual([`cd ${wt}`, 'domc "/clauditor continue"'])
    expect(out).not.toMatch(/run `claude`/)
  })

  it('falls back to the default command and skips cd without a cwd', () => {
    const out = manualRestartSteps(null, '')
    expect(out.split('\n').pop()).toBe(DEFAULT_RESUME_COMMAND)
    expect(out).not.toContain('cd ')
  })

  it('quotes a directory the shell would split', () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
    expect(shellQuote('/plain/path-1.x')).toBe('/plain/path-1.x')
  })

  it('startup warning names the launcher without the continue prompt', () => {
    expect(notWrappedWarning(wt, 'domc "/clauditor continue"')).toMatch(new RegExp(`cd ${wt.replace(/\./g, '\\.')} && domc$`))
    expect(notWrappedWarning(null, DEFAULT_RESUME_COMMAND)).toMatch(/then clauditor run$/)
  })
})
