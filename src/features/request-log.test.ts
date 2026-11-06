import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  appendRequest,
  chainRootFor,
  inlineRequest,
  readRequestLog,
  requestFromPrompt,
  requestLogPath,
  requestLogSummary,
  REQUEST_INLINE_MAX,
} from './request-log.js'
import { recordSessionOrigin } from './session-origin.js'

describe('requestFromPrompt', () => {
  it('keeps a plain prompt and the text carried by /clauditor continue', () => {
    expect(requestFromPrompt('put a vCard icon next to the phone')).toBe('put a vCard icon next to the phone')
    expect(requestFromPrompt('/clauditor continue make the columns narrower')).toBe('make the columns narrower')
    expect(requestFromPrompt('  /clauditor resume   and fix the footer ')).toBe('and fix the footer')
  })

  it('drops bare clauditor commands and empty prompts', () => {
    expect(requestFromPrompt('/clauditor continue')).toBeNull()
    expect(requestFromPrompt('/clauditor save')).toBeNull()
    expect(requestFromPrompt('/clauditor desktop on')).toBeNull()
    expect(requestFromPrompt('   ')).toBeNull()
  })

  it('keeps other slash commands: they are asks too', () => {
    expect(requestFromPrompt('/todo check the Monday board')).toBe('/todo check the Monday board')
  })
})

describe('appendRequest and readRequestLog', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'proj-'))
  })

  it('appends one JSON line per prompt, keyed by the session when it has no chain', () => {
    const p1 = appendRequest({ cwd, sessionId: 'sess-a', prompt: 'first ask' })
    const p2 = appendRequest({ cwd, sessionId: 'sess-a', prompt: 'second ask' })
    expect(p1).toBe(requestLogPath(cwd, 'sess-a'))
    expect(p2).toBe(p1)
    expect(p1!.startsWith(resolve(homedir(), '.clauditor', 'sessions'))).toBe(true)
    const entries = readRequestLog(p1!)
    expect(entries.map(e => e.prompt)).toEqual(['first ask', 'second ask'])
    expect(entries[0].session).toBe('sess-a')
    expect(Date.parse(entries[0].at)).toBeGreaterThan(0)
  })

  it('a resumed session writes to the chain root\'s log, not its own', () => {
    const origins = join(mkdtempSync(join(tmpdir(), 'orig-')), 'origins.json')
    // recordSessionOrigin's default file is ~/.clauditor/session-origins.json;
    // chainRootFor reads that default, so write there.
    const defaultFile = resolve(homedir(), '.clauditor', 'session-origins.json')
    mkdirSync(resolve(homedir(), '.clauditor'), { recursive: true })
    writeFileSync(defaultFile, '{}')
    expect(recordSessionOrigin('sess-b', 'the task', '/h/1.md', defaultFile, 'sess-root')).toBe(true)
    expect(chainRootFor('sess-b')).toBe('sess-root')
    expect(chainRootFor('sess-never-seen')).toBe('sess-never-seen')

    const path = appendRequest({ cwd, sessionId: 'sess-b', prompt: 'carried ask' })
    expect(path).toBe(requestLogPath(cwd, 'sess-root'))
    expect(readRequestLog(path!).map(e => e.prompt)).toEqual(['carried ask'])
    void origins
  })

  it('skips plumbing and never throws on bad input', () => {
    expect(appendRequest({ cwd, sessionId: 's', prompt: '/clauditor continue' })).toBeNull()
    expect(appendRequest({ cwd: null, sessionId: 's', prompt: 'x' })).toBeNull()
    expect(appendRequest({ cwd, sessionId: '', prompt: 'x' })).toBeNull()
    expect(appendRequest({ cwd, sessionId: 's', prompt: undefined })).toBeNull()
  })

  it('ignores malformed lines when reading', () => {
    const path = appendRequest({ cwd, sessionId: 'sess-c', prompt: 'ok' })!
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not json\n{"nope":1}\n')
    expect(readRequestLog(path).map(e => e.prompt)).toEqual(['ok'])
  })

  it('requestLogSummary counts the chain log and is null when there is none', () => {
    expect(requestLogSummary(cwd, 'sess-d')).toBeNull()
    appendRequest({ cwd, sessionId: 'sess-d', prompt: 'one' })
    appendRequest({ cwd, sessionId: 'sess-d', prompt: 'two' })
    expect(requestLogSummary(cwd, 'sess-d')).toEqual({ path: requestLogPath(cwd, 'sess-d'), count: 2 })
    expect(requestLogSummary(null, 'sess-d')).toBeNull()
  })
})

describe('inlineRequest', () => {
  it('flattens newlines and caps the length', () => {
    expect(inlineRequest('line one\n  line two')).toBe('line one ⏎ line two')
    const long = 'x'.repeat(REQUEST_INLINE_MAX + 50)
    expect(inlineRequest(long)).toHaveLength(REQUEST_INLINE_MAX + 1)
    expect(inlineRequest(long).endsWith('…')).toBe(true)
  })
})
