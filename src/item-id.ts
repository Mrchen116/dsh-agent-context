/** Stable, window-local short references reconstructed from original log order. */
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import { successfulCompactions } from './windows.ts'

// Native assembly may commit these controls after pre-step assigns pending IDs.
const controlSources = ['runtime-context', 'compact-checkpoint', 'agent-context', 'skill-catalog', 'agent-instructions']
export function itemMessage(event: SessionEvent): Message | undefined {
  const message = event.type === 'user/message' ? event.data
    : event.type === 'assistant/message' || event.type === 'tool/result' ? event.data.message : undefined
  if (!message || controlSources.includes(message.source.kind)) return undefined
  return message
}

/** Replacements retain their original number; successful resets start a new sequence. */
export function itemIds(events: readonly SessionEvent[], pending: readonly UserMessage[] = []): Map<string, string> {
  const ends = new Set(successfulCompactions(events).map(window => window.end_seq))
  const ids = new Map<string, string>()
  let next = 1
  for (const event of events) {
    if (ends.has(event.seq)) next = 1
    const message = itemMessage(event)
    if (message && !ids.has(message.id)) ids.set(message.id, String(next++))
  }
  for (const message of pending) {
    if (!controlSources.includes(message.source.kind) && !ids.has(message.id))
      ids.set(message.id, String(next++))
  }
  return ids
}

const marker = (id: string) => `\n[id: ${id}]`
function ownedItemId(content: readonly ContentBlock[]): string | undefined {
  const last = content.at(-1)
  return last?.type === 'text' && 'contextItemId' in last &&
    typeof last.contextItemId === 'string' && last.text === marker(last.contextItemId)
    ? last.contextItemId : undefined
}

export function stripItemId(content: readonly ContentBlock[]): ContentBlock[] {
  return ownedItemId(content) === undefined ? [...content] : content.slice(0, -1)
}

/** Annotate only admitted inputs, preserving their identity and original source. */
export function markInputs(session: Session, pending: readonly UserMessage[]): UserMessage[] {
  if (!pending.length) return []
  const ids = itemIds(session.snapshotEvents(), pending)
  return pending.map(message => {
    const id = ids.get(message.id)
    if (!id) return message
    const last = message.content.at(-1)
    if (last?.type === 'text' && 'contextItemId' in last && last.contextItemId === id && last.text === marker(id)) return message
    return freezeMessage({ ...message, content: [...stripItemId(message.content), { type: 'text', text: marker(id), contextItemId: id }] })
  })
}

/** Final results are annotated after tools and pruning, before the next model call. */
export function markToolResults(session: Session, meter: TokenMeter): void {
  let ids: Map<string, string> | undefined
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const message = session.deriveEventMessage(event)!
    if (message.role !== 'tool') continue
    const last = message.content.at(-1)
    if (last?.type === 'text' && 'contextItemId' in last && typeof last.contextItemId === 'string' && last.text === marker(last.contextItemId)) continue
    const id = (ids ??= itemIds(session.snapshotEvents())).get(message.id)!
    // Signed shadow pricing is required even when the replacement adds tokens.
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq],
      shadowedTokenCount: meter.estimateMessage(message),
    })
    session.append('tool/result', { ...event.data, message: freezeMessage({
      ...message, content: [...stripItemId(message.content), { type: 'text', text: marker(id), contextItemId: id }],
    }) }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
  }
}
