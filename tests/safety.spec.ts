import { expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countRollovers } from '../src/rollover.ts'
import { searchHistory } from '../src/history.ts'
import { NotesStore } from '../src/notes.ts'
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

it.each(['pressure', 'overflow'] as const)('locates already consumed Inbox work after %s reset with stale Notes and default budgets', async reason => {
  const { ctx, agent, session } = await engineHarness(`inbox-${reason}`, {}, { maxTokens: 32768 })
  await new NotesStore(NotesStore.directoryFor(agent.id, session.id)).write('checkpoint.md', 'Old greeting completed. No new work.')
  ctx.tools.register(defineTool({
    name: 'inbox', description: 'Read incoming work', parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ messages: [{ id: 'new-message-629', sender: { type: 'user', is_owner: true }, text: 'LATEST_TASK_629: read my journal and list the todos' }], observation: 'live' }),
  }))
  ctx.tools.register(defineTool({
    name: 'material', description: 'Read background material', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'background '.repeat(16000) }] },
    execute: async () => ({ ok: true }),
  }))
  const scripts = [
    textResponse('old completed material '.repeat(1000)),
    toolCall('inbox', '{}', 'inbox-read'),
    reason === 'pressure'
      ? withUsage(toolCall('material', '{}', 'large-read'), 223853)
      : errorFinish('capacity', CONTEXT_WINDOW_EXCEEDED_CODE),
    textResponse('request inspection only; this is not product acceptance'),
  ]
  class ProductionWindowAdapter extends ScriptedAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, context: { contextWindow: 258400 } }
    }
  }
  const adapter = new ProductionWindowAdapter(scripts)
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'old greeting')
  await followup(agent, 'System wake: check your inbox')
  expect(countRollovers(session)).toBe(1)
  const request = adapter.requests.at(-1)!.flatMap(message => message.content
    .filter(block => block.type === 'text').map(block => block.text)).join('\n')
  const recovery = /<interrupted_turn>\s*([^]*?)\s*<\/interrupted_turn>/.exec(request)
  expect(recovery, request.slice(0, 1000)).not.toBeNull()
  const navigation = JSON.parse(recovery![1]!)
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').at(-1)!
  expect(navigation.turn_id).toBe(String(turn.seq))
  expect(request).not.toContain('LATEST_TASK_629') // Raw task bodies still require History.
  expect(request).not.toContain('Old greeting completed.')
  const restored = Session.create(session.id, session.snapshotEvents())
  const page = searchHistory(restored, { ...navigation.history, role: 'tool', tool_name: 'inbox' })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]).toMatchObject({ role: 'tool', turn_id: String(turn.seq) })
  expect(page.items[0]!.content).toContain('LATEST_TASK_629')
  expect(page.items[0]!.content).toContain('new-message-629')
  expect(searchHistory(restored, { ...navigation.history, role: 'user' }).items.map(item => item.content)).toEqual(['System wake: check your inbox'])
})
