import { expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  textResponse,
  usageResponse,
  errorFinish,
  toolCall,
} from './harness.ts'
function withUsage(chunks: ReturnType<typeof toolCall>, inputTokens: number) {
  return [
    ...chunks.slice(0, -1),
    { type: 'usage' as const, usage: { inputTokens, outputTokens: 20 } },
    chunks.at(-1)!,
  ]
}
it('hard-cap pressure crosses multiple windows in the same turn, preserving only effective state', async () => {
  const { ctx, agent, session } = await engineHarness('hard-cap')
  ctx.systemPrompt.context({
    name: 'authorization',
    order: 10,
    text: 'CURRENT_AUTHORIZATION_POLICY',
  })
  ctx.tools.register(
    defineTool({
      name: 'material',
      description: 'Read material',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'material '.repeat(2000) }],
      },
      execute: async () => ({ ok: true }),
    }),
  )
  const adapter = new ScriptedAdapter([
    usageResponse('old response '.repeat(2000), 95000),
    withUsage(toolCall('material', '{}', 'm1'), 95000),
    withUsage(toolCall('material', '{}', 'm2'), 95000),
    textResponse('finished after pressure'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'old request')
  await followup(agent, 'NEW_TASK_INPUT')
  expect(countRollovers(session)).toBe(3)
  expect(
    session
      .snapshotEvents()
      .filter((e) => e.type === 'compaction/start')
      .map((e) => e.data.turn),
  ).toEqual([2, 2, 2])
  expect(JSON.stringify(adapter.requests[1])).toContain('NEW_TASK_INPUT')
  expect(JSON.stringify(adapter.requests[1])).not.toContain('old response')
  expect(JSON.stringify(adapter.requests.at(-1))).toContain(
    'CURRENT_AUTHORIZATION_POLICY',
  )
  expect(adapter.requests).toHaveLength(4)
})
it('overflow retries only after shrinking and stops when fixed-only input overflows again', async () => {
  const { ctx, agent, session } = await engineHarness('overflow')
  let state = 'before'
  ctx.systemPrompt.context({
    name: 'effective-state',
    order: 10,
    text: () => `STATE=${state}`,
  })
  const adapter = new ScriptedAdapter([
    textResponse('old material '.repeat(3000)),
    errorFinish('capacity', CONTEXT_WINDOW_EXCEEDED_CODE),
    errorFinish('still too large', CONTEXT_WINDOW_EXCEEDED_CODE),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'old user')
  state = 'current'
  await followup(agent, 'trigger overflow')
  expect(countRollovers(session)).toBe(1)
  expect(adapter.requests).toHaveLength(3)
  expect(JSON.stringify(adapter.requests[2])).toContain('STATE=current')
  expect(JSON.stringify(adapter.requests[2])).not.toContain('old material')
  expect(session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'error' } },
  })
})
it('manual reset uses the idle lease and rejects a non-shrinking context', async () => {
  const { ctx, engine, agent, session } = await engineHarness('manual')
  const adapter = new ScriptedAdapter([textResponse('evidence '.repeat(1000))])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'question')
  expect(
    await engine.compactNow(agent, new AbortController().signal),
  ).not.toBeNull()
  expect(countRollovers(session)).toBe(1)
  await expect(
    engine.compactNow(agent, new AbortController().signal),
  ).rejects.toThrow(/not smaller|no conversational progress/)
  expect(countRollovers(session)).toBe(1)
})
