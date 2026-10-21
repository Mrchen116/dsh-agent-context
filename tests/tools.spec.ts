import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  textResponse,
} from './harness.ts'
async function run(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('test'),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return JSON.parse(
    result.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
  )
}
it('renders complete paginated notes and archive recovery through the public tool runtime', async () => {
  const { ctx, agent, engine } = await engineHarness('tools', {
    bufferTokens: 10000,
    models: { 'mock:mock': { bufferTokens: 12000, reminderTokens: 5000 } },
  })
  expect(await run(ctx, agent, 'get_context_remaining', {})).toMatchObject({
    remaining: null,
    measurement: 'awaiting_first_request',
  })
  await run(ctx, agent, 'notes', {
    action: 'write',
    path: 'state',
    text: 'hello',
  })
  await run(ctx, agent, 'notes', {
    action: 'append',
    path: 'state',
    text: ' world',
  })
  expect(
    await run(ctx, agent, 'notes', { action: 'read', path: 'state' }),
  ).toMatchObject({ content: 'hello world', truncated: false })
  expect(
    (await run(ctx, agent, 'notes', { action: 'list' })).items[0],
  ).toMatchObject({ path: 'state', bytes: 11 })
  expect(
    (await run(ctx, agent, 'notes', { action: 'search', query: 'world' }))
      .items[0],
  ).toMatchObject({ line: 1, path: 'state' })
  const adapter = new ScriptedAdapter([
    textResponse('long evidence '.repeat(1000)),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'original requirement')
  const reading = await run(ctx, agent, 'get_context_remaining', {})
  expect(reading).toMatchObject({
    O: 10000,
    C: 100000,
    H: 90000,
    W: 78000,
    B: 12000,
    R: 5000,
    estimated: true,
    measurement: 'persisted-surface',
  })
  expect(reading.remaining).toBe(Math.max(0, reading.W - reading.T))
  expect(
    reading.references.items.some((i: { preview: string }) =>
      i.preview.includes('original requirement'),
    ),
  ).toBe(true)
  await engine.compactNow(agent, new AbortController().signal)
  const found = await run(ctx, agent, 'history', {
    action: 'search',
    query: 'original requirement',
  })
  expect(found.items).toHaveLength(1)
  const item = found.items[0]
  expect(
    await run(ctx, agent, 'history', {
      action: 'read',
      window_id: item.window_id,
      item_id: item.item_id,
    }),
  ).toMatchObject({ content: 'original requirement' })
  expect(
    (await run(ctx, agent, 'history', { action: 'list_windows' })).items,
  ).toHaveLength(1)
})
it('does not allow another session to address notes or historical references', async () => {
  const first = await engineHarness('one')
  await run(first.ctx, first.agent, 'notes', {
    action: 'write',
    path: 'private',
    text: 'secret',
  })
  const second = await engineHarness('two')
  expect(
    (await run(second.ctx, second.agent, 'notes', { action: 'list' })).items,
  ).toEqual([])
  await expect(
    run(second.ctx, second.agent, 'notes', {
      action: 'read',
      path: '../one/notes/private',
    }),
  ).rejects.toThrow(/invalid/)
  await expect(
    run(second.ctx, second.agent, 'history', {
      action: 'read',
      window_id: 'one:initial',
      item_id: '1',
    }),
  ).rejects.toThrow(/not_found/)
})
