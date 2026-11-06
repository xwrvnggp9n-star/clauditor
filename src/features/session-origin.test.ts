import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isResumePrompt,
  isResumeCommandMessage,
  originalTaskFromHandoff,
  truncateTask,
  recordSessionOrigin,
  readSessionOrigin,
  ORIGINAL_TASK_MAX,
} from './session-origin.js'

describe('isResumePrompt', () => {
  it('matches continue and resume, with or without text after', () => {
    expect(isResumePrompt('/clauditor continue')).toBe(true)
    expect(isResumePrompt('  /clauditor resume and fix the footer')).toBe(true)
    expect(isResumePrompt('/clauditor CONTINUE')).toBe(true)
  })

  it('rejects other clauditor commands and plain text', () => {
    expect(isResumePrompt('/clauditor save')).toBe(false)
    expect(isResumePrompt('/clauditor continuex')).toBe(false)
    expect(isResumePrompt('clauditor continue')).toBe(false)
    expect(isResumePrompt('please /clauditor continue')).toBe(false)
  })
})

describe('isResumeCommandMessage', () => {
  const cmd = (name: string, args: string) =>
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`

  it('matches the transcript form of /clauditor continue|resume', () => {
    expect(isResumeCommandMessage(cmd('clauditor', 'continue'))).toBe(true)
    expect(isResumeCommandMessage(cmd('clauditor', 'resume <task-notification>…</task-notification>'))).toBe(true)
  })

  it('rejects save, other commands, and a missing args block', () => {
    expect(isResumeCommandMessage(cmd('clauditor', 'save'))).toBe(false)
    expect(isResumeCommandMessage(cmd('cr', 'continue'))).toBe(false)
    expect(isResumeCommandMessage('<command-name>/clauditor</command-name>')).toBe(false)
  })
})

describe('originalTaskFromHandoff', () => {
  it('returns the section body up to the next heading', () => {
    const md = '# Last Session\n\n- **Branch:** x\n\n## Original Task\nfix the footer\nand the header\n\n## Commits Made\n- a'
    expect(originalTaskFromHandoff(md)).toBe('fix the footer\nand the header')
  })

  it('reads a section that runs to the end of the file', () => {
    expect(originalTaskFromHandoff('## Original Task\n  do it  \n')).toBe('do it')
  })

  it('returns null when the section is missing or empty', () => {
    expect(originalTaskFromHandoff('# Last Session\n## Task\nx')).toBeNull()
    expect(originalTaskFromHandoff('## Original Task\n\n## Task\nx')).toBeNull()
  })
})

describe('truncateTask', () => {
  it('keeps a task at the cap and cuts one past it', () => {
    const atCap = 'x'.repeat(ORIGINAL_TASK_MAX)
    expect(truncateTask(atCap)).toBe(atCap)
    expect(truncateTask(atCap + 'y')).toBe(atCap + '...')
  })
})

describe('recordSessionOrigin / readSessionOrigin', () => {
  let file: string
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'clauditor-origin-')), 'origins.json')
  })

  it('files a task under the session id and reads it back', () => {
    expect(recordSessionOrigin('s1', '  list the worktrees  ', '/h/1.md', file)).toBe(true)
    expect(readSessionOrigin('s1', file)).toBe('list the worktrees')
    const entry = JSON.parse(readFileSync(file, 'utf-8')).s1
    expect(entry.from).toBe('/h/1.md')
    expect(Date.parse(entry.at)).not.toBeNaN()
  })

  it('keeps the first origin recorded for a session', () => {
    recordSessionOrigin('s1', 'first', null, file)
    expect(recordSessionOrigin('s1', 'second', null, file)).toBe(false)
    expect(readSessionOrigin('s1', file)).toBe('first')
  })

  it('refuses an empty task or session id', () => {
    expect(recordSessionOrigin('s1', '   ', null, file)).toBe(false)
    expect(recordSessionOrigin('', 'task', null, file)).toBe(false)
    expect(readSessionOrigin('s1', file)).toBeNull()
  })

  it('drops entries older than 30 days, and undated ones, on the next write', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(file, JSON.stringify({
      old: { task: 'old', from: null, at: old },
      recent: { task: 'recent', from: null, at: recent },
      undated: { task: 'undated', from: null },
    }))
    recordSessionOrigin('new', 'new', null, file)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf-8'))).sort()).toEqual(['new', 'recent'])
  })

  it('caps a long task and survives a corrupt file', () => {
    writeFileSync(file, 'not json')
    expect(readSessionOrigin('s1', file)).toBeNull()
    recordSessionOrigin('s1', 'x'.repeat(ORIGINAL_TASK_MAX + 50), null, file)
    expect(readSessionOrigin('s1', file)!.length).toBe(ORIGINAL_TASK_MAX + 3)
  })
})

describe('chain root', () => {
  it('chainRootFromHandoff reads the Chain line', async () => {
    const { chainRootFromHandoff } = await import('./session-origin.js')
    expect(chainRootFromHandoff('# Last Session\n\n- **Branch:** main\n- **Chain:** abc-123_x\n')).toBe('abc-123_x')
    expect(chainRootFromHandoff('# Last Session\n\n- **Branch:** main\n')).toBeNull()
  })

  it('recordSessionOrigin files a root, defaulting to the session, and accepts an empty task with a root', async () => {
    const { readSessionRoot } = await import('./session-origin.js')
    const file = join(mkdtempSync(join(tmpdir(), 'orig-')), 'origins.json')
    expect(recordSessionOrigin('s1', 'task', null, file)).toBe(true)
    expect(readSessionRoot('s1', file)).toBe('s1')
    expect(recordSessionOrigin('s2', '', null, file, 'root-0')).toBe(true)
    expect(readSessionRoot('s2', file)).toBe('root-0')
    expect(readSessionOrigin('s2', file)).toBeNull()
    expect(recordSessionOrigin('s3', '', null, file)).toBe(false)
    expect(readSessionRoot('nope', file)).toBeNull()
  })
})
