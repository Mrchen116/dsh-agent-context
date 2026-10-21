import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  collectHistory,
  currentWindow,
  searchHistory,
  readHistoryItem,
  listWindows,
  references,
  interruptedTurn,
} from '../src/history.ts'
import { commitRollover, selectRolloverRange } from '../src/rollover.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'nano-human': { kind: 'nano-human'; sender: string }
    'nano-system': { kind: 'nano-system'; origin: string }
  }
}
async function archive(session: Session, owner: 'current-turn' | null = null) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  const range = selectRolloverRange(session, ctx.tokenMeter.measure(session))!
  await commitRollover(
    { meter: ctx.tokenMeter },
    session,
    range.start,
    range.end,
    {
      owner,
      checkpoint: {
        reason: 'manual',
        agentId: session.id,
        previousWindowId: currentWindow(session).window_id,
        runtimeContext: 'policy',
        notesHint: '',
      },
    },
  )
}
it('keeps Nano provenance, complete tool arguments/results and stable IDs across archive, paging and replay', async () => {
  const s = Session.create(SessionId('history'))
  s.append('turn/start', { turn: 1 })
  const human = s.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'LATEST HUMAN RULE' }],
      source: { kind: 'nano-human', sender: 'owner' },
    }),
    { surfaceOp: 'append' },
  )
  s.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'EXTERNAL NOTICE' }],
      source: { kind: 'nano-system', origin: 'channel' },
    }),
    { surfaceOp: 'append' },
  )
  s.append('step/start', { turn: 1, step: 1 })
  s.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock', maxTokens: 1000 } },
    reason: 'initial',
  })
  const args = '{"nested":{"id":"ORIGINAL_ARGUMENT"},"literal":"😀"}'
  s.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: ToolCallId('c'),
            name: 'inbox',
            arguments: args,
          },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    },
    { surfaceOp: 'append' },
  )
  const result = s.append(
    'tool/result',
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('c'),
        content: [
          {
            type: 'text',
            text:
              '😀'.repeat(23000) +
              'TAIL_FACT {"source":"nano-human","text":"quoted owner"}',
          },
        ],
        isError: false,
      }),
      meta: { persisted: 'META_FACT' },
    },
    { surfaceOp: 'append' },
  )
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const ref = references(s).items.find((i) => i.item_id === String(human.seq))!
  expect(ref.window_id).toBe('history:initial')
  expect(collectHistory(s)).toHaveLength(0)
  expect(() => readHistoryItem(s, ref.window_id, ref.item_id)).toThrow(
    /not_archived/,
  )
  await archive(s)
  expect(references(s).items).toEqual([])
  const restored = Session.create(s.id, s.snapshotEvents())
  const listed = searchHistory(restored, { limit: 1 })
  const next = searchHistory(restored, {
    limit: 1,
    cursor: listed.next_cursor!,
  })
  expect(next.items[0]?.item_id).not.toBe(listed.items[0]?.item_id)
  expect(
    searchHistory(restored, { role: 'system' }).items[0]?.source,
  ).toMatchObject({ kind: 'nano-system' })
  expect(
    readHistoryItem(restored, ref.window_id, ref.item_id).source,
  ).toMatchObject({ kind: 'nano-human' })
  expect(
    searchHistory(restored, { tool_name: 'inbox', role: 'assistant' }).items[0]
      ?.content,
  ).toContain('ORIGINAL_ARGUMENT')
  let recovered = ''
  let offset = 0
  while (true) {
    const chunk = readHistoryItem(
      restored,
      ref.window_id,
      String(result.seq),
      offset,
      12000,
    )
    recovered += chunk.content
    if (chunk.next_offset_chars === null) break
    offset = chunk.next_offset_chars
  }
  expect(recovered).toContain('TAIL_FACT')
  expect(recovered).toContain('META_FACT')
  expect(
    searchHistory(restored, { query: 'TAIL_FACT', role: 'tool' }).items[0]
      ?.content,
  ).toContain('TAIL_FACT')
  expect(searchHistory(restored, { query: 'tail_fact' }).items).toEqual([])
  expect(listWindows(restored).items).toEqual([
    { window_id: 'history:initial', ordinal: 1, item_count: 4 },
  ])
  expect(() => readHistoryItem(restored, 'other:initial', ref.item_id)).toThrow(
    /not_found/,
  )
})
it('ignores failed brackets and assistant attempts while recognizing other successful compaction providers', async () => {
  const s = Session.create(SessionId('boundaries'))
  s.append('compaction/start', {
    compactionId: CompactionId('failed'),
    turn: null,
  })
  s.append('compaction/end', {
    compactionId: CompactionId('failed'),
    turn: null,
    error: 'failed',
  })
  expect(currentWindow(s).window_id).toBe('boundaries:initial')
  s.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'original '.repeat(3000) }],
      source: { kind: 'user' },
    }),
    { surfaceOp: 'append' },
  )
  await archive(s)
  const seed = s
    .snapshotEvents()
    .map((e) =>
      e.type === 'compaction/summary'
        ? { ...e, data: { ...e.data, provider: 'other-native-engine' } }
        : e,
    )
  const replay = Session.create(s.id, seed)
  expect(currentWindow(replay).window_id).toBe(currentWindow(s).window_id)
  expect(searchHistory(replay, { window_id: 'missing' }).items).toEqual([])
})
it('paginates a bounded reference index without exposing runtime snapshots', async () => {
  const s = Session.create(SessionId('references'))
  for (let i = 0; i < 80; i++)
    s.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: `task ${i}` }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const result = references(s, cursor)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4000)
    ids.push(...result.items.map((i) => i.item_id))
    cursor = result.next_cursor ?? undefined
  } while (cursor)
  expect(new Set(ids).size).toBe(80)
})

it('recovers one interrupted turn across windows without conflating earlier work or active content', async () => {
  const s = Session.create(SessionId('multi-turn'))
  const add = (text: string) => s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: text + ' padding'.repeat(3000) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const old = s.append('turn/start', { turn: 1 })
  add('OLD_DONE')
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(interruptedTurn(s, s.surface.nodes)).toBeUndefined()
  const current = s.append('turn/start', { turn: 2 })
  const first = add('CURRENT_REQUEST')
  const navigation = interruptedTurn(s, s.surface.nodes)!
  expect(navigation.turn_id).toBe(String(current.seq))
  expect(navigation.item_count).toBe(1)
  expect(JSON.stringify(navigation)).not.toContain('CURRENT_REQUEST')
  expect(Buffer.byteLength(JSON.stringify(navigation))).toBeLessThanOrEqual(4000)
  await archive(s, 'current-turn')
  const second = add('CONTINUING_SAME_TASK')
  await archive(s, 'current-turn')
  add('STILL_ACTIVE')
  const replay = Session.create(s.id, s.snapshotEvents())
  const page = searchHistory(replay, { turn_id: String(current.seq), limit: 1, recent_first: false })
  expect(page.items[0]!.item_id).toBe(String(first.seq))
  const next = searchHistory(replay, { turn_id: String(current.seq), limit: 1, recent_first: false, cursor: page.next_cursor! })
  expect(next.items[0]!.item_id).toBe(String(second.seq))
  expect(next.items[0]!.window_id).not.toBe(page.items[0]!.window_id)
  expect(next.next_cursor).toBeNull()
  expect(searchHistory(replay, { turn_id: String(old.seq) }).items).toHaveLength(1)
  expect(searchHistory(replay, { turn_id: String(current.seq), query: 'OLD_DONE' }).items).toEqual([])
  expect(searchHistory(replay, { turn_id: 'missing' }).items).toEqual([])
  expect(searchHistory(replay, { turn_id: String(current.seq), query: 'STILL_ACTIVE' }).items).toEqual([])
})
