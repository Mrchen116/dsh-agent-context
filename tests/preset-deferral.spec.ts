import { expect, it } from 'vitest'
import { getTraceable } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { ContextRolloverEngine } from '../src/index.ts'
import { countRollovers } from '../src/rollover.ts'
import { resolveConfig } from '../src/config.ts'
import {
  engineHarness,
  mountTestContext,
  followup,
  newContextCall,
  ScriptedAdapter,
  textResponse,
} from './harness.ts'
function roster(ctx: Context, owner: CompactionEngine | undefined) {
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide(
    'agentPresets',
    { serviceFor: () => owner },
  )
}
it('defers all compaction paths to a different preset owner and reports the tool refusal', async () => {
  const { ctx, engine, agent, session } = await engineHarness('preset-owned')
  roster(ctx, {} as CompactionEngine)
  const adapter = new ScriptedAdapter([
    newContextCall('{}'),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'reset')
  expect(
    await engine.compactNow(agent, new AbortController().signal),
  ).toBeNull()
  expect(
    await engine.compactIfNeeded(
      agent,
      'context-overflow',
      new AbortController().signal,
    ),
  ).toBeNull()
  await expect(
    engine.compactRegion(
      session.surface.nodes[0]!,
      session.surface.nodes.at(-1)!,
      agent,
    ),
  ).rejects.toThrow(/not active/)
  expect(countRollovers(session)).toBe(0)
  expect(
    session
      .snapshotEvents()
      .filter((e) => e.type === 'tool/result')
      .at(-1),
  ).toMatchObject({ data: { message: { isError: true } } })
})
it('recognizes its own traced owner and registers model surface only for the configured scope role', async () => {
  const ctx = await mountTestContext()
  roster(ctx, undefined)
  new ContextRolloverEngine(ctx)
  expect(ctx.tools.get('notes')).toBeUndefined()
  await ctx.fiber.dispose()
  const fresh = await mountTestContext()
  roster(fresh, undefined)
  new ContextRolloverEngine(fresh, { modelSurface: 'always' })
  for (const name of [
    'notes',
    'history',
    'new_context',
    'get_context_remaining',
  ])
    expect(fresh.tools.get(name)).toBeDefined()
  await fresh.fiber.dispose()
  const { ctx: live, agent, engine } = await engineHarness('self-owner')
  roster(live, getTraceable(live, engine))
  await expect(
    engine.compactNow(agent, new AbortController().signal),
  ).rejects.toThrow(/no complete/)
  expect(() => resolveConfig({ modelSurface: 'invalid' as 'auto' })).toThrow(
    /modelSurface/,
  )
})
