import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROTATE_ENV, requestRotation, markRotationReady, readRotateMarker } from './auto-rotate.js'

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
