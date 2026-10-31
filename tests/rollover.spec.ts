import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createSystemMessage,
  createAssistantMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  commitRollover,
  selectRolloverRange,
  countRollovers,
} from '../src/rollover.ts'
import { appendExchange } from './harness.ts'
import { currentWindow } from '../src/history.ts'
async function fixture(text = 'long evidence '.repeat(400)) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  const session = Session.create(SessionId('range-test'))
  session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('SYSTEM') },
    { surfaceOp: 'append' },
  )
  appendExchange(session, 1, text, true)
  return { ctx, meter: ctx.tokenMeter, session }
}
const checkpoint = {
  reason: 'manual' as const,
  previousWindowId: 'range-test:initial',
  notesHint: '',
  runtimeContext: 'CURRENT_POLICY',
}
it('replaces all paired messages after the system head and keeps durable original events', async () => {
  const { meter, session } = await fixture()
  const before = [...session.surface.nodes]
  const range = selectRolloverRange(session, meter.measure(session))!
  expect(range.shadowedSeqs).toEqual(before.slice(1))
  const result = await commitRollover(
    { meter },
    session,
    range.start,
    range.end,
    { owner: null, checkpoint },
  )
  expect(session.deriveMessages()).toHaveLength(2)
  expect(session.deriveMessages()[0]?.role).toBe('system')
  expect(JSON.stringify(session.deriveMessages())).not.toContain(
    'long evidence',
  )
  expect(currentWindow(session).window_id).toBe(
    `${session.id}:${result.startSeq}`,
  )
  expect(session.eventAt(before[1]!)?.type).toBe('user/message')
  expect(countRollovers(session)).toBe(1)
})
it('does not split an unfinished tool pair or accept partial-tail replacement', async () => {
  const { meter, session } = await fixture()
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append(
    'assistant/message',
    {
      turn: 2,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [
          {
            type: 'tool-call',
            id: ToolCallId('open'),
            name: 'pending',
            arguments: '{}',
          },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    },
    { surfaceOp: 'append' },
  )
  expect(selectRolloverRange(session, meter.measure(session))).toBeNull()
})
it('a non-shrinking or locked transaction never creates a successful window', async () => {
  const { meter, session } = await fixture('tiny')
  const range = selectRolloverRange(session, meter.measure(session))!
  await expect(
    commitRollover({ meter }, session, range.start, range.end, {
      owner: null,
      checkpoint: { ...checkpoint, runtimeContext: 'huge '.repeat(1000) },
    }),
  ).rejects.toThrow(/not smaller/)
  expect(countRollovers(session)).toBe(0)
  expect(session.snapshotEvents().at(-1)).toMatchObject({
    type: 'compaction/end',
    data: { error: expect.anything() },
  })
  session.append('compaction/start', {
    compactionId: CompactionId('locked'),
    turn: null,
  })
  await expect(
    commitRollover({ meter }, session, range.start, range.end, {
      owner: null,
      checkpoint,
    }),
  ).rejects.toThrow(/in progress/)
  expect(countRollovers(session)).toBe(0)
})
