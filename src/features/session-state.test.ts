import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { extractSessionStateFromTranscript, saveSessionState, readLastSessionState, recordOriginFromNewestHandoff } from './session-state.js'
import { recordSessionOrigin, readSessionOrigin } from './session-origin.js'

function makeUserRecord(id: string, content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${id}`,
    parentUuid: null,
    sessionId: 's1',
    timestamp: '2026-04-03T12:00:00Z',
    message: { role: 'user', content },
    cwd: '/home/user/project',
    gitBranch: 'feat/test',
    version: '2.1.91',
    ...extra,
  })
}

function makeAssistantRecord(id: string, opts: {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number };
}) {
  const content: unknown[] = []
  if (opts.text) {
    content.push({ type: 'text', text: opts.text })
  }
  if (opts.toolCalls) {
    for (const tc of opts.toolCalls) {
      content.push({ type: 'tool_use', id: `tool-${id}`, name: tc.name, input: tc.input })
    }
  }
  const tokens = opts.tokens || { input: 1000, output: 500, cacheRead: 8000, cacheCreate: 200 }
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${id}`,
    parentUuid: `u-${id}`,
    sessionId: 's1',
    timestamp: '2026-04-03T12:00:00Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      id: `msg_${id}`,
      content,
      usage: {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_creation_input_tokens: tokens.cacheCreate,
        cache_read_input_tokens: tokens.cacheRead,
      },
    },
  })
}

describe('extractSessionStateFromTranscript', () => {
  let tempDir: string

  function writeSession(lines: string[]): string {
    const filePath = join(tempDir, 'session.jsonl')
    writeFileSync(filePath, lines.join('\n'))
    return filePath
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clauditor-session-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts original task from first user message', () => {
    const lines = [
      makeUserRecord('1', 'Build a REST API for user management'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: `response ${i}` })),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.originalTask).toBe('Build a REST API for user management')
  })

  it('extracts recent user messages (last 3)', () => {
    const lines = [
      makeUserRecord('1', 'First task'),
      makeAssistantRecord('a1', { text: 'ok' }),
      makeUserRecord('2', 'Second message'),
      makeAssistantRecord('a2', { text: 'ok' }),
      makeUserRecord('3', 'Third message'),
      makeAssistantRecord('a3', { text: 'ok' }),
      makeUserRecord('4', 'Fourth message'),
      makeAssistantRecord('a4', { text: 'ok' }),
      makeUserRecord('5', 'Fifth message'),
      makeAssistantRecord('a5', { text: 'ok' }),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.recentUserMessages).toHaveLength(3)
    expect(result!.recentUserMessages[0]).toBe('Third message')
    expect(result!.recentUserMessages[2]).toBe('Fifth message')
  })

  it('extracts files modified and read', () => {
    const lines = [
      makeUserRecord('1', 'Fix the bug'),
      ...Array.from({ length: 5 }, (_, i) =>
        makeAssistantRecord(`a${i}`, {
          toolCalls: [
            { name: 'Read', input: { file_path: '/project/src/app.ts' } },
            { name: 'Edit', input: { file_path: '/project/src/utils.ts' } },
          ],
        })
      ),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.filesModified).toContain('utils.ts')
    expect(result!.filesRead).toContain('app.ts')
  })

  it('extracts git commits', () => {
    const lines = [
      makeUserRecord('1', 'Fix the bug'),
      ...Array.from({ length: 5 }, (_, i) =>
        makeAssistantRecord(`a${i}`, {
          toolCalls: [
            { name: 'Bash', input: { command: 'git commit -m "fix: resolve null pointer bug"' } },
          ],
        })
      ),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.gitCommits).toContain('fix: resolve null pointer bug')
  })

  it('extracts key bash commands (test, build)', () => {
    const lines = [
      makeUserRecord('1', 'Run tests'),
      ...Array.from({ length: 5 }, (_, i) =>
        makeAssistantRecord(`a${i}`, {
          toolCalls: [
            { name: 'Bash', input: { command: 'npm test' } },
            { name: 'Bash', input: { command: 'npm run build' } },
          ],
        })
      ),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.keyCommands).toContain('npm test')
    expect(result!.keyCommands).toContain('npm run build')
  })

  it('captures last assistant message', () => {
    const lines = [
      makeUserRecord('1', 'Do something'),
      makeAssistantRecord('a1', { text: 'Working on it...' }),
      makeAssistantRecord('a2', { text: 'Here is the plan:\n1. Step one\n2. Step two' }),
      makeAssistantRecord('a3', { text: 'Done! Next steps:\n1. Run tests\n2. Deploy' }),
      makeAssistantRecord('a4', { text: 'Final message with plan' }),
      makeAssistantRecord('a5', { text: 'ok' }),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    // Should be the last assistant text message
    expect(result!.lastAssistantMessage).toBe('ok')
  })

  it('returns null for sessions with fewer than 5 turns', () => {
    const lines = [
      makeUserRecord('1', 'Quick question'),
      makeAssistantRecord('a1', { text: 'Answer' }),
      makeAssistantRecord('a2', { text: 'More' }),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).toBeNull()
  })

  it('truncates original task to 2000 chars', () => {
    const longTask = 'x'.repeat(2500)
    const lines = [
      makeUserRecord('1', longTask),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: 'ok' })),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.originalTask!.length).toBe(2003) // 2000 + '...'
  })

  it('a session opened with /clauditor continue takes the chain\'s original task', () => {
    const resume = '<command-message>clauditor</command-message>\n<command-name>/clauditor</command-name>\n<command-args>continue</command-args>'
    const lines = [
      makeUserRecord('1', resume),
      makeUserRecord('2', 'now also fix the footer'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: 'ok' })),
    ]
    const path = join(tempDir, 'resumed-1234.jsonl')
    writeFileSync(path, lines.join('\n'))
    recordSessionOrigin('resumed-1234', 'list all the worktrees and branches', null)
    expect(extractSessionStateFromTranscript('placeholder', path)!.originalTask).toBe('list all the worktrees and branches')
  })

  it('a resumed session with no origin on file keeps its own first prompt', () => {
    const resume = '<command-name>/clauditor</command-name><command-args>continue</command-args>'
    const lines = [
      makeUserRecord('1', resume),
      makeUserRecord('2', 'now also fix the footer'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: 'ok' })),
    ]
    const path = join(tempDir, 'unrecorded-99.jsonl')
    writeFileSync(path, lines.join('\n'))
    expect(extractSessionStateFromTranscript('unrecorded-99', path)!.originalTask).toBe('now also fix the footer')
  })

  it('a session that typed a prompt first ignores any origin on file', () => {
    const lines = [
      makeUserRecord('1', 'my own task'),
      makeUserRecord('2', '<command-name>/clauditor</command-name><command-args>continue</command-args>'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: 'ok' })),
    ]
    const path = join(tempDir, 'typed-first.jsonl')
    writeFileSync(path, lines.join('\n'))
    recordSessionOrigin('typed-first', 'someone else\'s task', null)
    expect(extractSessionStateFromTranscript('typed-first', path)!.originalTask).toBe('my own task')
  })

  it('skips meta messages for original task', () => {
    const lines = [
      // Meta message (isMeta: true) — should be skipped
      makeUserRecord('meta', '<local-command-caveat>Do not respond</local-command-caveat>', { isMeta: true }),
      // Real user message
      makeUserRecord('1', 'Build a REST API'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: `response ${i}` })),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.originalTask).toBe('Build a REST API')
    expect(result!.originalTask).not.toContain('local-command-caveat')
  })

  it('skips messages starting with XML tags', () => {
    const lines = [
      makeUserRecord('1', '<command-name>/clear</command-name>'),
      makeUserRecord('2', 'The real task starts here'),
      ...Array.from({ length: 6 }, (_, i) => makeAssistantRecord(`a${i}`, { text: `response ${i}` })),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.originalTask).toBe('The real task starts here')
  })

  it('extracts git commits from HEREDOC format', () => {
    const heredocCmd = "git commit -m \"$(cat <<'EOF'\nfeat: add new feature\n\nhttps://claude.ai/code/session_123\nEOF\n)\""
    const lines = [
      makeUserRecord('1', 'Do work'),
      ...Array.from({ length: 5 }, (_, i) =>
        makeAssistantRecord(`a${i}`, {
          toolCalls: [{ name: 'Bash', input: { command: heredocCmd } }],
        })
      ),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.gitCommits).toContain('feat: add new feature')
  })

  it('truncates last assistant message to 500 chars', () => {
    const longMsg = 'y'.repeat(1000)
    const lines = [
      makeUserRecord('1', 'task'),
      ...Array.from({ length: 5 }, (_, i) => makeAssistantRecord(`a${i}`, { text: longMsg })),
    ]
    const result = extractSessionStateFromTranscript('s1', writeSession(lines))
    expect(result).not.toBeNull()
    expect(result!.lastAssistantMessage!.length).toBeLessThanOrEqual(500)
  })
})

describe('saveSessionState and readLastSessionState', () => {
  // These write to ~/.clauditor/ which we can't easily mock
  // Just test the round-trip format

  it('saves and reads markdown format with all sections', () => {
    const data = {
      savedAt: '2026-04-03 15:30',
      branch: 'feat/test',
      cwd: '/home/user/project',
      turns: 50,
      tokensPerTurn: 45,
      wasteFactor: 5,
      filesModified: ['app.ts', 'utils.ts'],
      filesRead: ['config.ts'],
      originalTask: 'Build a REST API',
      recentUserMessages: ['Add pagination', 'Run the tests'],
      gitCommits: ['feat: add pagination endpoint'],
      keyCommands: ['npm test', 'npm run build'],
      lastAssistantMessage: 'Next: deploy to staging',
    }

    saveSessionState(data)
    const content = readLastSessionState()

    expect(content).not.toBeNull()
    expect(content).toContain('feat/test')
    expect(content).toContain('Build a REST API')
    expect(content).toContain('feat: add pagination endpoint')
    expect(content).toContain('npm test')
    expect(content).toContain('Add pagination')
    expect(content).toContain('Next: deploy to staging')
    expect(content).toContain('config.ts')
    expect(content).toContain('## Where We Left Off')
    expect(content).toContain('## Original Task')
    expect(content).toContain('## Commits Made')
    expect(content).toContain('## Key Commands & Results')
    expect(content).toContain('## Recent User Messages')
  })
})

describe('recordOriginFromNewestHandoff', () => {
  // vitest.setup.ts points HOME at a temp dir, so this is not the real ~/.clauditor
  const handoffDir = (cwd: string) =>
    join(homedir(), '.clauditor', 'sessions', cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-'))

  it("files the newest handoff's Original Task under the session id", () => {
    const cwd = '/work/proj-a'
    mkdirSync(handoffDir(cwd), { recursive: true })
    const now = Date.now()
    writeFileSync(join(handoffDir(cwd), `${now - 60_000}.md`), '# Last Session\n## Original Task\nolder task\n')
    writeFileSync(join(handoffDir(cwd), `${now}.md`), '# Last Session\n## Original Task\nlist the worktrees\n\n## Task\nx\n')
    expect(recordOriginFromNewestHandoff('sess-a', cwd)).toBe(true)
    expect(readSessionOrigin('sess-a')).toBe('list the worktrees')
  })

  it('records nothing when the newest handoff has no Original Task, or there is none', () => {
    const cwd = '/work/proj-b'
    expect(recordOriginFromNewestHandoff('sess-b', cwd)).toBe(false)
    mkdirSync(handoffDir(cwd), { recursive: true })
    writeFileSync(join(handoffDir(cwd), `${Date.now()}.md`), '# Last Session\n## Task\nx\n')
    expect(recordOriginFromNewestHandoff('sess-b', cwd)).toBe(false)
    expect(readSessionOrigin('sess-b')).toBeNull()
    expect(recordOriginFromNewestHandoff('sess-b', null)).toBe(false)
  })
})

describe('verbatim user requests and the chain', () => {
  // vitest.setup.ts points HOME at a temp dir, so this is not the real ~/.clauditor
  const handoffDir = (cwd: string) =>
    join(homedir(), '.clauditor', 'sessions', cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-'))

  function transcript(dir: string, name: string, lines: string[]): string {
    const p = join(dir, `${name}.jsonl`)
    writeFileSync(p, lines.join('\n') + '\n')
    return p
  }

  it('keeps every typed request verbatim, not just the last three, and names the chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-'))
    const lines: string[] = []
    for (let i = 1; i <= 7; i++) {
      lines.push(makeUserRecord(`${i}`, `ask number ${i}`))
      lines.push(makeAssistantRecord(`${i}`, { text: `did ${i}` }))
    }
    const path = transcript(dir, 'sess-v', lines)
    const state = extractSessionStateFromTranscript('sess-v', path)!
    expect(state.userRequests).toHaveLength(7)
    expect(state.userRequests[0]).toBe('ask number 1')
    expect(state.userRequests[6]).toBe('ask number 7')
    expect(state.recentUserMessages).toHaveLength(3)
    expect(state.sessionId).toBe('sess-v')
    expect(state.chainRoot).toBe('sess-v')

    saveSessionState(state)
    const md = readLastSessionState()!
    expect(md).toContain('- **Chain:** sess-v')
    expect(md).toContain('## User Requests (this session, verbatim)')
    expect(md).toContain('1. ask number 1')
    expect(md).toContain('7. ask number 7')
    expect(md).not.toContain('## Recent User Messages')
  })

  it('a resumed session lists the text carried by /clauditor continue and writes to the chain root', async () => {
    const { recordSessionOrigin } = await import('./session-origin.js')
    const { appendRequest } = await import('./request-log.js')
    const cwd = '/home/user/project'
    recordSessionOrigin('sess-r', 'the original ask', '/h/0.md', undefined, 'sess-root')
    appendRequest({ cwd, sessionId: 'sess-root', prompt: 'the original ask' })
    appendRequest({ cwd, sessionId: 'sess-r', prompt: 'carried over ask' })

    const dir = mkdtempSync(join(tmpdir(), 'tr-'))
    const lines = [
      makeUserRecord('0', '<command-message>clauditor</command-message>\n<command-name>/clauditor</command-name>\n<command-args>continue carried over ask</command-args>'),
      makeAssistantRecord('0', { text: 'resuming' }),
    ]
    for (let i = 1; i <= 5; i++) {
      lines.push(makeUserRecord(`${i}`, `follow-up ${i}`))
      lines.push(makeAssistantRecord(`${i}`, { text: `ok ${i}` }))
    }
    const path = transcript(dir, 'sess-r', lines)
    const state = extractSessionStateFromTranscript('sess-r', path)!
    expect(state.originalTask).toBe('the original ask')
    expect(state.chainRoot).toBe('sess-root')
    expect(state.userRequests[0]).toBe('carried over ask')
    expect(state.userRequests).toHaveLength(6)

    saveSessionState(state)
    const md = readLastSessionState()!
    expect(md).toContain('- **Chain:** sess-root')
    expect(md).toMatch(/Chain request log \(every prompt since the chain began, 2 so far\): .*requests-sess-root\.jsonl/)
  })

  it('recordOriginFromNewestHandoff carries the Chain line, and starts a new chain for an old handoff without one', async () => {
    const { readSessionRoot } = await import('./session-origin.js')
    const cwd = '/work/proj-chain'
    mkdirSync(handoffDir(cwd), { recursive: true })
    writeFileSync(join(handoffDir(cwd), `${Date.now()}.md`),
      '# Last Session\n\n- **Branch:** main\n- **Chain:** root-77\n\n## Original Task\nship it\n')
    expect(recordOriginFromNewestHandoff('sess-c1', cwd)).toBe(true)
    expect(readSessionOrigin('sess-c1')).toBe('ship it')
    expect(readSessionRoot('sess-c1')).toBe('root-77')

    const cwd2 = '/work/proj-chain-2'
    mkdirSync(handoffDir(cwd2), { recursive: true })
    writeFileSync(join(handoffDir(cwd2), `${Date.now()}.md`), '# Last Session\n\n- **Chain:** root-88\n\n## Task\nx\n')
    // no Original Task, but a chain: the chain still carries
    expect(recordOriginFromNewestHandoff('sess-c2', cwd2)).toBe(true)
    expect(readSessionOrigin('sess-c2')).toBeNull()
    expect(readSessionRoot('sess-c2')).toBe('root-88')
  })
})

describe('OPEN_REQUESTS in a structured handoff', () => {
  it('is parsed and rendered first, after Task', async () => {
    const { parseStructuredHandoff, savePostCompactSummary } = await import('./session-state.js')
    const summary = [
      'TASK: ship the dialog batch',
      '',
      'OPEN_REQUESTS:',
      '- display the phone as a phone number — NOT STARTED',
      '- vCard icon beside it — IN PROGRESS',
      '',
      'COMPLETED:',
      '- dialog opens over the week (v1.2.3)',
      '',
      'IN_PROGRESS:',
      '- nothing',
    ].join('\n')
    const parsed = parseStructuredHandoff(summary)
    expect(parsed.isStructured).toBe(true)
    expect(parsed.openRequests).toEqual([
      'display the phone as a phone number — NOT STARTED',
      'vCard icon beside it — IN PROGRESS',
    ])

    await savePostCompactSummary(summary, '/work/proj-open', null)
    const md = readLastSessionState()!
    expect(md.indexOf('## Open Requests')).toBeGreaterThan(md.indexOf('## Task'))
    expect(md.indexOf('## Open Requests')).toBeLessThan(md.indexOf('## Completed'))
    expect(md).toContain('- vCard icon beside it — IN PROGRESS')
  })
})
