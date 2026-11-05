import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export interface WindowInfo {
  window_id: string
  ordinal: number
  start_seq: number
  end_seq: number
}

/** Successful native brackets are shared by navigation and item numbering. */
export function successfulCompactions(events: readonly SessionEvent[]): Array<{start_seq: number; end_seq: number}> {
  const result: Array<{start_seq: number; end_seq: number}> = []
  const starts = new Map<string, number>()
  const summaries = new Set<string>()
  for (const event of events) {
    if (event.type === 'compaction/start') starts.set(event.data.compactionId, event.seq)
    if (event.type === 'compaction/summary') summaries.add(event.data.compactionId)
    if (event.type === 'compaction/end' && event.data.error === undefined && summaries.has(event.data.compactionId)) {
      const seq = starts.get(event.data.compactionId)
      if (seq !== undefined) result.push({start_seq: seq, end_seq: event.seq})
    }
  }
  return result
}

export function snapshotWindows(sessionId: string, events: readonly SessionEvent[]): WindowInfo[] {
  return [
    {window_id: `${sessionId}:initial`, ordinal: 1, start_seq: -1, end_seq: -1},
    ...successfulCompactions(events).map((boundary,index) => ({
      window_id: `${sessionId}:${boundary.start_seq}`, ordinal: index + 2, ...boundary,
    })),
  ]
}

/** Current persisted windows, also valid after restoration or fork. */
export function windows(session: Session): WindowInfo[] {
  return snapshotWindows(session.id, session.snapshotEvents())
}

export function currentWindow(session: Session): WindowInfo {
  return windows(session).at(-1)!
}
