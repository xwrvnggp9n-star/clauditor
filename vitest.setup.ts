import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Modules resolve ~/.clauditor from homedir() when they load, so give every
// test file a throwaway HOME. Without this, tests that save handoffs wrote
// fixtures into the real ~/.clauditor (last-session.md, sessions/, the index).
process.env.HOME = mkdtempSync(join(tmpdir(), 'clauditor-test-home-'))
