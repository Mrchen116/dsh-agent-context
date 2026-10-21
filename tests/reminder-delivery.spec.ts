import { expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextRolloverEngine } from '../src/index.ts'
import { currentWindow } from '../src/history.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  usageResponse,
  textResponse,
  mountTestContext,
} from './harness.ts'

it('delivers reminder and fallback once per window, with committed references, including after restoration', async () => {
  const { ctx, agent, session } = await engineHarness('budget-state', {
    bufferTokens: 10000,
    reminderTokens: 10000,
  })
  const adapter = new ScriptedAdapter([
    usageResponse('large output '.repeat(800), 72000),
    usageResponse('second output', 80500),
    usageResponse('third output', 80500),
    textResponse('fourth'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'rule one')
  await followup(agent, 'rule two')
  await followup(agent, 'rule three')
  await followup(agent, 'rule four')
  const notices = session
    .snapshotEvents()
    .filter(
      (e) =>
        e.type === 'user/message' && e.data.source.kind === 'agent-context',
    )
  expect(notices).toHaveLength(2)
  expect(JSON.stringify(notices[0])).toContain('nearly exhausted')
  expect(JSON.stringify(notices[1])).toContain(
    'Make exactly one write or append',
  )
  expect(JSON.stringify(notices[1])).toContain('rule two')
  expect(JSON.stringify(notices[1])).not.toContain('get_context_remaining')
  // Reconstruct a fresh Session and plugin instance. The public pre-step seam
  // must not reissue persisted reminders just because process memory is gone.
  const restored = Session.create(session.id, session.snapshotEvents())
  const fresh = await mountTestContext()
  new ContextRolloverEngine(fresh, {
    bufferTokens: 10000,
    reminderTokens: 10000,
  })
  const carrier = {
    id: agent.id,
    ctx: agent.ctx,
    session: restored,
    options: agent.options,
  } as Agent
  const decision = await agentEvents(fresh, carrier).waterfall(
    'agent/pre-step',
    { messages: [], turn: 5, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages: [] }),
  )
  expect(decision).toMatchObject({ kind: 'enter', messages: [] })
  expect(currentWindow(restored).window_id).toBe(`${session.id}:initial`)
  await fresh.fiber.dispose()
})

it('continues uncapped model requests using a labeled output reserve without changing the request cap', async () => {
  const { ctx, agent, session } = await engineHarness('uncapped-budget', {}, {})
  const adapter = new ScriptedAdapter([textResponse('one'), textResponse('two')])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'first task')
  await followup(agent, 'next task')
  expect(adapter.requests).toHaveLength(2)
  expect(session.snapshotEvents().at(-1)).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  expect(session.requestHeader()?.config.maxTokens).toBeUndefined()
  const { budget } = await import('../src/budget.ts')
  expect(budget(agent, ctx.tokenMeter, { modelSurface: 'always' })).toMatchObject({
    O: 25000,
    output_reserve_source: 'policy-estimate',
  })
})
