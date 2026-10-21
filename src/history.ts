import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { boundedInteger } from './notes.ts'
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export interface WindowInfo {
  window_id: string
  ordinal: number
  start_seq: number
  end_seq: number
}
export interface HistoryItem {
  window_id: string
  item_id: string
  ordinal: number
  seq: number
  event_type: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  source: { [key: string]: Json } | null
  tool_names: string[]
  content: string
}
export interface HistoryQuery {
  window_id?: string
  role?: string
  tool_name?: string
  query?: string
  limit?: number
  cursor?: string
  recent_first?: boolean
  max_chars_per_item?: number
}
/** Successful native compaction brackets define windows, regardless of compaction provider. */
export function windows(session: Session): WindowInfo[] {
  const result: WindowInfo[] = [
    {
      window_id: `${session.id}:initial`,
      ordinal: 1,
      start_seq: -1,
      end_seq: -1,
    },
  ]
  const starts = new Map<string, number>()
  const summaries = new Set<string>()
  for (const event of session.snapshotEvents()) {
    if (event.type === 'compaction/start')
      starts.set(event.data.compactionId, event.seq)
    if (event.type === 'compaction/summary')
      summaries.add(event.data.compactionId)
    if (
      event.type === 'compaction/end' &&
      event.data.error === undefined &&
      summaries.has(event.data.compactionId)
    ) {
      const seq = starts.get(event.data.compactionId)
      if (seq !== undefined)
        result.push({
          window_id: `${session.id}:${seq}`,
          ordinal: result.length + 1,
          start_seq: seq,
          end_seq: event.seq,
        })
    }
  }
  return result
}
/** Current persisted window identity, also valid after session restoration. */
export function currentWindow(session: Session): WindowInfo {
  return windows(session).at(-1)!
}
function excluded(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return (
    (source.kind as string) === 'runtime-context' ||
    source.kind === 'compact-checkpoint' ||
    (source.kind as string) === 'agent-context'
  )
}
/** Normalize the persisted message payload losslessly; provenance stays in its original role. */
export function normalizedItems(session: Session): HistoryItem[] {
  const boundaries = windows(session)
  const calls = new Map<string, string>()
  const items: HistoryItem[] = []
  for (const event of session.snapshotEvents()) {
    if (excluded(event)) continue
    const message =
      event.type === 'user/message'
        ? event.data
        : event.type === 'assistant/message' || event.type === 'tool/result'
          ? event.data.message
          : undefined
    if (message === undefined) continue
    let role: HistoryItem['role'] =
      event.type === 'assistant/message'
        ? 'assistant'
        : event.type === 'tool/result'
          ? 'tool'
          : 'user'
    if (
      event.type === 'user/message' &&
      !['user', 'nano-human'].includes(event.data.source.kind)
    )
      role = 'system'
    const names: string[] = []
    for (const block of message.content)
      if (block.type === 'tool-call') {
        calls.set(block.id, block.name)
        names.push(block.name)
      }
    if (message.role === 'tool') {
      const name = calls.get(message.toolCallId)
      if (name) names.push(name)
    }
    const window =
      boundaries.findLast((w) => event.seq > w.end_seq) ?? boundaries[0]!
    // JSON preserves complete calls, arguments, result payloads and attachment metadata.
    // Text blocks additionally retain readable newlines for bounded recovery.
    const blocks = message.content
      .map((block) =>
        block.type === 'text' ? block.text : JSON.stringify(block),
      )
      .join('\n')
    const content =
      event.type === 'tool/result'
        ? `${blocks}\n${JSON.stringify({ ...event.data, message: { ...event.data.message, content: undefined } })}`
        : blocks
    items.push({
      window_id: window.window_id,
      item_id: String(event.seq),
      ordinal: window.ordinal,
      seq: event.seq,
      event_type: event.type,
      role,
      source: JSON.parse(JSON.stringify(message.source)) as {
        [key: string]: Json
      },
      tool_names: names,
      content,
    })
  }
  return items
}
/** Archived messages only; active message bodies never leak through History. */
export function collectHistory(session: Session): HistoryItem[] {
  const active = new Set<number>(session.surface.nodes)
  return normalizedItems(session).filter((item) => !active.has(item.seq))
}
function slicePage<T extends { seq: number }>(items: T[], query: HistoryQuery) {
  const recent = query.recent_first ?? true
  let sorted = [...items].sort((a, b) =>
    recent ? b.seq - a.seq : a.seq - b.seq,
  )
  if (query.cursor !== undefined) {
    const match = /^(desc|asc):(\d+)$/.exec(query.cursor)
    if (!match || match[1] !== (recent ? 'desc' : 'asc'))
      throw new Error('invalid cursor direction')
    const seq = Number(match[2])
    sorted = sorted.filter((x) => (recent ? x.seq < seq : x.seq > seq))
  }
  const limit = boundedInteger(query.limit, 20, 100)
  const page = sorted.slice(0, limit)
  return {
    items: page,
    next_cursor:
      sorted.length > page.length
        ? `${recent ? 'desc' : 'asc'}:${page.at(-1)!.seq}`
        : null,
  }
}
function metadata(item: HistoryItem) {
  const { content: _content, seq: _seq, ...result } = item
  return result
}
/** List or search archived items with stable directional sequence cursors. */
export function searchHistory(session: Session, query: HistoryQuery = {}) {
  const filtered = collectHistory(session).filter(
    (item) =>
      (query.window_id === undefined || item.window_id === query.window_id) &&
      (query.role === undefined || item.role === query.role) &&
      (query.tool_name === undefined ||
        item.tool_names.includes(query.tool_name)) &&
      (query.query === undefined || item.content.includes(query.query)),
  )
  const page = slicePage(filtered, query)
  const max = boundedInteger(query.max_chars_per_item, 1000, 4000)
  return {
    ...page,
    items: page.items.map((item) => {
      const chars = Array.from(item.content)
      const offset =
        query.query === undefined
          ? 0
          : Math.max(
              0,
              Array.from(
                item.content.slice(0, item.content.indexOf(query.query)),
              ).length - 80,
            )
      return {
        ...metadata(item),
        content: chars.slice(offset, offset + max).join(''),
        offset_chars: offset,
        truncated: chars.length > offset + max,
      }
    }),
  }
}
/** List only windows that actually contain archived messages. */
export function listWindows(session: Session, query: HistoryQuery = {}) {
  const counts = new Map<string, number>()
  for (const item of collectHistory(session))
    counts.set(item.window_id, (counts.get(item.window_id) ?? 0) + 1)
  const page = slicePage(
    windows(session)
      .filter((w) => counts.has(w.window_id))
      .map((w) => ({ ...w, seq: w.start_seq + 1 })),
    query,
  )
  return {
    ...page,
    items: page.items.map((w) => ({
      window_id: w.window_id,
      ordinal: w.ordinal,
      item_count: counts.get(w.window_id)!,
    })),
  }
}
/** Read a Unicode code point slice of one archived item; reject active and cross-session references. */
export function readHistoryItem(
  session: Session,
  windowId: string,
  itemId: string,
  offset = 0,
  limit = 12000,
) {
  const item = normalizedItems(session).find(
    (i) => i.item_id === itemId && i.window_id === windowId,
  )
  if (!item) throw new Error('not_found: no item in this session and window')
  if (session.surface.nodes.some((seq) => seq === item.seq))
    throw new Error('not_archived: item is still in the active context')
  const chars = Array.from(item.content)
  boundedInteger(offset, 0, chars.length, 0)
  boundedInteger(limit, 12000, 20000)
  const end = Math.min(chars.length, offset + limit)
  return {
    ...metadata(item),
    total_chars: chars.length,
    content: chars.slice(offset, end).join(''),
    truncated: end < chars.length,
    next_offset_chars: end < chars.length ? end : null,
  }
}
/** Bounded current references, excluding this plugin's own control records. */
export function references(session: Session, cursor?: string) {
  const active = new Set<number>(session.surface.nodes)
  const page = slicePage(
    normalizedItems(session).filter((item) => active.has(item.seq)),
    {
      limit: 32,
      ...(cursor === undefined ? {} : { cursor }),
    },
  )
  const items: {
    window_id: string
    item_id: string
    event_type: string
    role: HistoryItem['role']
    source: Json
    tool_names: string[]
    preview: string
  }[] = []
  let bytes = 0
  for (const item of page.items) {
    const value = {
      window_id: item.window_id,
      item_id: item.item_id,
      event_type: item.event_type,
      role: item.role,
      source: item.source?.kind ?? null,
      tool_names: item.tool_names,
      preview: Array.from(item.content).slice(0, 80).join(''),
    }
    const size = Buffer.byteLength(JSON.stringify(value)) + 1
    if (bytes + size > 3800) break
    items.push(value)
    bytes += size
  }
  const last = items.at(-1)
  return {
    items,
    next_cursor:
      items.length < page.items.length && last
        ? `desc:${last.item_id}`
        : page.next_cursor,
  }
}
export function referenceText(session: Session): string {
  return `<context_references>\n${JSON.stringify(references(session))}\n</context_references>`
}
