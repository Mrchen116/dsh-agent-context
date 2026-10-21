import { mkdtemp, rm, symlink, chmod, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NotesStore } from '../src/notes.ts'
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-context-'))
  dirs.push(dir)
  return new NotesStore(dir)
}
it('appends exactly, serializes concurrent writes and rejects oversized UTF-8 without changing the file', async () => {
  const s = await store()
  await s.write('计划.md', 'A')
  await Promise.all([s.append('计划.md', 'B'), s.append('计划.md', '\nC')])
  expect(await s.read('计划.md')).toBe('AB\nC')
  await expect(s.append('计划.md', '中'.repeat(333334))).rejects.toThrow(
    /1,000,000|1000000/,
  )
  expect(await s.read('计划.md')).toBe('AB\nC')
})
it('resumes an oversized Unicode line without dropping its tail; queries are bounded and case sensitive', async () => {
  const s = await store()
  await s.write('plan/a', 'start\n' + '😀'.repeat(30) + 'TAIL\nend')
  const first = await s.readSlice('plan/a', { start_line: 2, max_chars: 20 })
  const second = await s.readSlice('plan/a', {
    start_line: first.next_line!,
    offset_chars: first.next_offset_chars!,
    max_chars: 20,
  })
  expect(first.content + second.content).toBe('😀'.repeat(30) + 'TAIL\nend')
  expect((await s.search('TAIL', { path_prefix: 'plan' })).items).toHaveLength(
    1,
  )
  expect((await s.search('tail')).items).toHaveLength(0)
  expect((await s.list({ limit: 1 })).items[0]?.bytes).toBeGreaterThan(30)
})
it('rejects traversal and symlinks, reports missing reads and keeps hint body-free', async () => {
  const s = await store()
  const other = await store()
  await other.write('secret', 'SECRET')
  await symlink(other.root, join(s.root, 'escape'))
  await expect(s.read('escape/secret')).rejects.toThrow(/symbolic|symlink/)
  await expect(s.write('../secret', 'x')).rejects.toThrow(/invalid/)
  await expect(s.read('missing')).rejects.toThrow()
  await s.write('safe', 'BODY_PRIVATE')
  expect(await s.hint()).toContain('safe')
  expect(await s.hint()).not.toContain('BODY_PRIVATE')
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'does not overwrite an existing note when append cannot read it',
  async () => {
    const s = await store()
    await s.write('state', 'preserve me')
    const path = join(s.root, 'state')
    await chmod(path, 0o200)
    try {
      await expect(s.append('state', 'extra')).rejects.toMatchObject({
        code: 'EACCES',
      })
    } finally {
      await chmod(path, 0o600)
    }
    expect(await readFile(path, 'utf8')).toBe('preserve me')
  },
)

it('renders the Codex recent-notes hint with newest-first paths and line/UTF-8 counts', async () => {
  const s = await store()
  expect(await s.hint()).toBe('')
  await s.write('checkpoint', 'old')
  await s.write('on-checkpoint', '新状态\ncontinue')
  await utimes(join(s.root, 'checkpoint'), 1000, 1000)
  await utimes(join(s.root, 'on-checkpoint'), 2000, 2000)
  expect(await s.hint()).toBe(
    'Recent notes (up to 5, most-recent first):\n' +
    '- on-checkpoint (2 lines, 18 UTF-8 bytes)\n' +
    '- checkpoint (1 lines, 3 UTF-8 bytes)',
  )
})
