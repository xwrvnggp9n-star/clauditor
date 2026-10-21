import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionWatcher } from './watcher.js'
import { SessionStore } from './store.js'

function writeSession(dir: string, id: string, ageMs: number) {
  const line = JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    parentUuid: null,
    sessionId: id,
    timestamp: '2025-01-01T00:00:00Z',
    cwd: '/tmp/x',
    message: { role: 'user', content: 'hello' },
  })
  const reply = JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    parentUuid: `u-${id}`,
    sessionId: id,
    timestamp: '2025-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, line + '\n' + reply + '\n')
  const t = new Date(Date.now() - ageMs)
  utimesSync(file, t, t)
}

describe('SessionWatcher.scanRecent', () => {
  it('keeps only the newest files inside the age window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clauditor-scan-'))
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const day = 24 * 60 * 60 * 1000
    writeSession(proj, 'new1', 1000)
    writeSession(proj, 'new2', 2000)
    writeSession(proj, 'new3', 3000)
    writeSession(proj, 'ancient', 30 * day)

    const store = new SessionStore()
    await new SessionWatcher(store, { projectsDir: root }).scanRecent(2, 14 * day)

    const ids = store.getAll().map((s) => s.sessionId).sort()
    expect(ids).toEqual(['new1', 'new2'])
  })
})
