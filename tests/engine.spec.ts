import { expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { countRollovers } from '../src/rollover.ts'
import { NotesStore } from '../src/notes.ts'
import { currentWindow, collectHistory } from '../src/history.ts'
import {
  engineHarness,
  followup,
  newContextCall,
  ScriptedAdapter,
  textResponse,
  toolCall,
} from './harness.ts'

it('rebuilds effective runtime state and drops the old snapshot, all tail and note bodies in the first new request', async () => {
  const { ctx, agent, session } = await engineHarness('native-window')
  const note = new NotesStore(NotesStore.directoryFor(agent.id, session.id))
  await note.write('state.md', 'PRIVATE_NOTE_BODY')
  let mode = 'approval-required'
  ctx.systemPrompt.context({
    name: 'effective-policy',
    order: 10,
    text: () => `POLICY:${mode}`,
  })
  const adapter = new ScriptedAdapter([
    textResponse('OLD_ASSISTANT ' + 'evidence '.repeat(1000)),
    newContextCall('{}'),
    textResponse('continued'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'OLD_USER')
  expect(JSON.stringify(adapter.requests[0])).not.toContain('Agent name:')
  expect(JSON.stringify(adapter.requests[0])).not.toContain('Session ID:')
  mode = 'approval-current'
  let steered = false
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (!steered && exec.name === 'new_context') {
      steered = true
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: 'NEW_INPUT_MUST_SURVIVE' }],
          source: { kind: 'user' },
        }),
      )
    }
    return next()
  })
  await followup(agent, 'request a reset')
  expect(countRollovers(session)).toBe(1)
  const request = JSON.stringify(
    adapter.requests.at(-1)!.filter((m) => m.role !== 'system'),
  )
  expect(request).toContain(
    `Current context window id: ${currentWindow(session).window_id}`,
  )
  expect(request).not.toContain(
    `Current context window id: ${session.id}:initial`,
  )
  expect(request).not.toContain('Agent name:')
  expect(request).not.toContain('Session ID:')
  expect(request).toContain('POLICY:approval-current')
  expect(request).toContain('NEW_INPUT_MUST_SURVIVE')
  expect(request).toContain('<context_references>')
  expect(request).toContain('state.md')
  expect(request).not.toContain('PRIVATE_NOTE_BODY')
  expect(request).not.toContain('OLD_ASSISTANT')
  expect(request).not.toContain('OLD_USER')
  expect(adapter.requests).toHaveLength(3)
  expect(
    collectHistory(session).some((i) => i.content.includes('OLD_USER')),
  ).toBe(true)
})

it('continues three useful windows in one turn without an LLM summary request', async () => {
  const { ctx, agent, session } = await engineHarness('three-windows')
  ctx.tools.register(
    defineTool({
      name: 'material',
      description: 'read material',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: () => [{ type: 'text', text: 'large evidence '.repeat(1200) }],
      },
      execute: async () => ({ ok: true }),
    }),
  )
  const adapter = new ScriptedAdapter([
    toolCall('material', '{}', 'm1'),
    newContextCall('{}', 'n1'),
    toolCall('material', '{}', 'm2'),
    newContextCall('{}', 'n2'),
    toolCall('material', '{}', 'm3'),
    newContextCall('{}', 'n3'),
    textResponse('finished'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'Complete the task across windows')
  expect(countRollovers(session)).toBe(3)
  expect(adapter.requests).toHaveLength(7)
  expect(JSON.stringify(adapter.requests.at(-1))).not.toContain(
    'large evidence',
  )
  expect(
    session.snapshotEvents().filter((e) => e.type === 'turn/start'),
  ).toHaveLength(1)
})

it('does not copy unchanged runtime instructions for ordinary progress or Notes changes', async () => {
  const { ctx, engine, agent } = await engineHarness('stable-context')
  ctx.systemPrompt.context({
    name: 'restored-instructions',
    order: 10,
    text: 'STABLE_SKILL_BODY ' + 'instructions '.repeat(1000),
  })
  const adapter = new ScriptedAdapter([
    textResponse('old material '.repeat(2000)),
    toolCall('notes', JSON.stringify({ action: 'write', path: 'new.md', text: 'progress' }), 'n1'),
    toolCall('notes', JSON.stringify({ action: 'read', path: 'new.md' }), 'n2'),
    toolCall('get_context_remaining', '{}', 'b1'),
    toolCall('notes', JSON.stringify({ action: 'append', path: 'new.md', text: 'next' }), 'n3'),
    toolCall('notes', JSON.stringify({ action: 'read', path: 'new.md' }), 'n4'),
    textResponse('probe complete'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'previous task')
  await engine.compactNow(agent, new AbortController().signal)
  await followup(agent, 'new task')
  const copies = adapter.requests.slice(1).map(request => request.flatMap(message =>
    message.content.filter(block => block.type === 'text').map(block => block.text),
  ).join('\n').split('STABLE_SKILL_BODY').length - 1)
  expect(copies).toHaveLength(6)
  expect(copies[0]).toBeGreaterThan(0)
  expect(copies).toEqual(Array(6).fill(copies[0]))
})
