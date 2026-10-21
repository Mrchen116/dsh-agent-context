import {
  mkdir,
  readdir,
  readFile,
  lstat,
  rename,
  writeFile,
  rm,
} from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const MAX_BYTES = 1_000_000
const writes = new Map<string, Promise<unknown>>()
export interface PageOptions {
  path_prefix?: string
  limit?: number
  cursor?: string
}
export interface ReadOptions {
  start_line?: number
  end_line?: number
  offset_chars?: number
  max_chars?: number
}
export type NoteListing = { path: string; bytes: number; mtime: number }

/** Validate a session-relative note path without expanding shell syntax. */
export function resolveNotePath(dir: string, path: string): string {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error(`invalid note path: ${path}`)
  }
  return join(dir, path)
}
export function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  min = 1,
): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`expected integer in [${min}, ${max}]`)
  return n
}
function page<T>(items: T[], options: PageOptions) {
  const limit = boundedInteger(options.limit, 20, 100)
  const start = options.cursor === undefined ? 0 : Number(options.cursor)
  boundedInteger(start, 0, Number.MAX_SAFE_INTEGER, 0)
  return {
    items: items.slice(start, start + limit),
    next_cursor: start + limit < items.length ? String(start + limit) : null,
  }
}

/** Durable files owned by exactly one Agent session; successful writes are immediately visible. */
export class NotesStore {
  constructor(readonly root: string) {}
  /** Resolve the host-provided DSH home namespace; IDs are path segments, never paths. */
  static directoryFor(agentId: string, sessionId: string): string {
    return dshHomePath(
      'agent-context',
      encodeURIComponent(agentId),
      encodeURIComponent(sessionId),
      'notes',
    )
  }
  private async checked(path: string): Promise<string> {
    const absolute = resolveNotePath(this.root, path)
    // Refuse symlinks at every level, including the namespace root. This is a
    // file API boundary, not a sandbox against concurrent hostile host code.
    let current = this.root
    for (const part of ['', ...path.split('/')]) {
      if (part) current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`symbolic link is not a note path: ${path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return absolute
  }
  private async listings(prefix = ''): Promise<NoteListing[]> {
    if (prefix) resolveNotePath(this.root, prefix)
    const out: NoteListing[] = []
    const walk = async (relative: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(
          relative ? await this.checked(relative) : this.root,
          { withFileTypes: true },
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && path.startsWith(prefix)) {
          const info = await lstat(await this.checked(path))
          out.push({ path, bytes: info.size, mtime: info.mtimeMs })
        }
      }
    }
    await this.checked('namespace-check')
    await walk('')
    return out.sort(
      (a, b) =>
        b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
  }
  /** List a bounded page, newest modified files first, with a stable path tie-break. */
  async list(options: PageOptions = {}) {
    return page(await this.listings(options.path_prefix), options)
  }
  /** Read raw content for local store operations. Model callers use readSlice. */
  async read(path: string): Promise<string> {
    return readFile(await this.checked(path), 'utf8')
  }
  /** Read an inclusive line range, continuing oversized lines with Unicode code point offsets. */
  async readSlice(path: string, options: ReadOptions = {}) {
    const lines = (await this.read(path)).split('\n')
    const start = boundedInteger(options.start_line, 1, lines.length)
    const end = boundedInteger(options.end_line, lines.length, lines.length)
    if (end < start) throw new Error('invalid line range: end precedes start')
    const offset = boundedInteger(
      options.offset_chars,
      0,
      Array.from(lines[start - 1]!).length,
      0,
    )
    const max = boundedInteger(options.max_chars, 12000, 20000)
    const content = Array.from(lines.slice(start - 1, end).join('\n')).slice(
      offset,
    )
    const chunk = content.slice(0, max).join('')
    const consumed = chunk.split('\n')
    const nextLine = start + consumed.length - 1
    const nextOffset =
      consumed.length === 1
        ? offset + Array.from(chunk).length
        : Array.from(consumed.at(-1)!).length
    const truncated = content.length > max
    return {
      path,
      content: chunk,
      truncated,
      next_line: truncated ? nextLine : null,
      next_offset_chars: truncated ? nextOffset : null,
    }
  }
  private async update(path: string, text: string, append: boolean) {
    const key = resolveNotePath(this.root, path)
    const previous = writes.get(key) ?? Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const absolute = await this.checked(path)
        let existing = ''
        if (append) {
          try {
            existing = await readFile(absolute, 'utf8')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const content = existing + text
        const bytes = Buffer.byteLength(content)
        if (bytes > MAX_BYTES)
          throw new Error(
            'note exceeds 1,000,000 UTF-8 bytes; write another file',
          )
        await mkdir(dirname(absolute), { recursive: true })
        await this.checked(path)
        const temporary = `${absolute}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
          await rename(temporary, absolute)
        } finally {
          await rm(temporary, { force: true })
        }
        return { path, bytes }
      })
    writes.set(key, operation)
    try {
      return await operation
    } finally {
      if (writes.get(key) === operation) writes.delete(key)
    }
  }
  /** Atomically replace one note within the byte limit. */
  write(path: string, text: string) {
    return this.update(path, text, false)
  }
  /** Append text verbatim, serializing mutations of the same file. */
  append(path: string, text: string) {
    return this.update(path, text, true)
  }
  /** Search literal, case-sensitive text and return bounded line snippets. */
  async search(query: string, options: PageOptions = {}) {
    if (!query) throw new Error('search requires a nonempty query')
    const matches: { path: string; line: number; content: string }[] = []
    for (const listing of await this.listings(options.path_prefix)) {
      const lines = (await this.read(listing.path)).split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const index = line.indexOf(query)
        if (index < 0) continue
        const offset = Array.from(line.slice(0, index)).length
        matches.push({
          path: listing.path,
          line: i + 1,
          content: Array.from(line)
            .slice(Math.max(0, offset - 80), offset + 240)
            .join(''),
        })
      }
    }
    return page(matches, options)
  }
  /** Navigation only: never inject note bodies into a new window. */
  async hint(): Promise<string> {
    const header = 'Recent notes (up to 5, most-recent first):'
    const entries: string[] = []
    for (const file of (await this.listings()).slice(0, 5)) {
      const lines = (await this.read(file.path)).split('\n').length
      const entry = `- ${file.path} (${lines} lines, ${file.bytes} UTF-8 bytes)`
      const candidate = [header, ...entries, entry].join('\n')
      if (Buffer.byteLength(candidate) > 4000) break
      entries.push(entry)
    }
    return entries.length ? [header, ...entries].join('\n') : ''
  }
}
