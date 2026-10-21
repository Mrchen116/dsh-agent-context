import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import * as prompts from '../src/guidance.ts'
import { engineHarness } from './harness.ts'
it('keeps the approved Codex wording and the argument-free new_context schema', async () => {
  const mapping = {
    guidance_message: 'CONTEXT_MANAGEMENT_GUIDANCE',
    reminder_message_template: 'REMINDER_TEMPLATE',
    auto_compact_fallback_prompt: 'FALLBACK_PROMPT',
    HISTORY_DESCRIPTION: 'HISTORY_DESCRIPTION',
    NOTES_DESCRIPTION: 'NOTES_DESCRIPTION',
  } as const
  for (const [fixture, key] of Object.entries(mapping))
    expect(prompts[key]).toBe(
      JSON.parse(
        readFileSync(
          new URL(`./prompts/${fixture}.json`, import.meta.url),
          'utf8',
        ),
      ).adapted,
    )
  const { ctx } = await engineHarness('discovery')
  expect(ctx.tools.get('new_context')?.parameters).toEqual({
    type: 'object',
    properties: {},
  })
  expect(ctx.tools.get('history')?.description).toBe(
    prompts.HISTORY_DESCRIPTION,
  )
  expect(ctx.tools.get('notes')?.description).toBe(prompts.NOTES_DESCRIPTION)
  expect(ctx.tools.get('get_context_remaining')?.parameters).toHaveProperty(
    'properties.references_cursor',
  )
})
