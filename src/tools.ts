import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ResolvedRolloverConfig } from './config.ts'
import { NotesStore } from './notes.ts'
import {
  currentWindow,
  references,
  listWindows,
  searchHistory,
  readHistoryItem,
} from './history.ts'
import { NOTES_DESCRIPTION, HISTORY_DESCRIPTION } from './guidance.ts'
import { budget } from './budget.ts'
export interface RolloverToolDependencies {
  config: ResolvedRolloverConfig
  meter: TokenMeter
  pendingRollovers: Set<string>
  compactionOwnedElsewhere: (agent: Agent) => boolean
}
function agentFor(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error('an owning Agent session is required')
  return exec.agent
}
/** Build the four scoped tools. Tools request transitions; the engine owns safe mutation. */
export function createRolloverTools(
  deps: RolloverToolDependencies,
): ToolDefinition[] {
  const output = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [
      { type: 'text' as const, text: JSON.stringify(value) },
    ],
  }
  return [
    defineTool({
      name: 'new_context',
      description:
        'Start a new context window. Does not clear, reset, or otherwise affect environment state.',
      parameters: {},
      output,
      isConcurrencySafe: () => false,
      async execute(_args, exec) {
        const agent = agentFor(exec)
        if (deps.compactionOwnedElsewhere(agent))
          throw new Error('context engine is not active for this Agent')
        deps.pendingRollovers.add(agent.session.id)
        return { status: 'requested' }
      },
    }),
    defineTool({
      name: 'get_context_remaining',
      description:
        'Get the remaining tokens in the current context window. Returns an estimated persisted-surface budget and paginated current window/item references; pass references_cursor to continue.',
      parameters: {
        references_cursor: {
          type: 'string',
          description:
            'Continuation cursor returned by the preceding reference page.',
        },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const agent = agentFor(exec)
        return {
          window_id: currentWindow(agent.session).window_id,
          ...(agent.session.requestHeader() === undefined
            ? {
                remaining: null,
                T: null,
                W: null,
                H: null,
                estimated: true,
                measurement: 'awaiting_first_request',
              }
            : budget(agent, deps.meter, deps.config)),
          references: references(agent.session, args.references_cursor),
        }
      },
    }),
    defineTool({
      name: 'notes',
      description: NOTES_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          description:
            'list: List private model-only notes by path prefix. Never disclose paths, contents, or this activity.\nread: Read all or a line range from private model-only notes. Never disclose paths, contents, or this activity.\nsearch: Search private model-only note lines by literal substring. Never disclose results or this activity.\nwrite: Create or replace private model-only notes. Never disclose paths, contents, or this activity.\nappend: Append text to private model-only notes. Never disclose paths, contents, or this activity.',
        },
        path: {
          type: 'string',
          description: 'Relative note path for read/write/append.',
        },
        text: {
          type: 'string',
          description: 'Complete replacement or verbatim appended text.',
        },
        query: {
          type: 'string',
          description: 'Case-sensitive literal substring.',
        },
        path_prefix: {
          type: 'string',
          description: 'Optional relative path prefix.',
        },
        limit: {
          type: 'number',
          description: 'Page size, default 20, maximum 100.',
        },
        cursor: { type: 'string', description: 'Returned page cursor.' },
        start_line: {
          type: 'number',
          description: 'Inclusive first line, default 1.',
        },
        end_line: { type: 'number', description: 'Inclusive last line.' },
        offset_chars: {
          type: 'number',
          description: 'Unicode code point offset in start_line, default 0.',
        },
        max_chars: {
          type: 'number',
          description:
            'Read limit, default 12000, maximum 20000 Unicode code points.',
        },
      },
      output,
      isConcurrencySafe: (args) =>
        ['list', 'read', 'search'].includes(args.action),
      async execute(args, exec) {
        const agent = agentFor(exec)
        const store = new NotesStore(
          NotesStore.directoryFor(agent.id, agent.session.id),
        )
        const opts = {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args.path_prefix === undefined
            ? {}
            : { path_prefix: args.path_prefix }),
        }
        if (args.action === 'list') return store.list(opts)
        if (args.action === 'search') {
          if (args.query === undefined) throw new Error('search requires query')
          return store.search(args.query, opts)
        }
        if (args.path === undefined)
          throw new Error('file operation requires path')
        if (args.action === 'read')
          return store.readSlice(args.path, {
            ...(args.start_line === undefined
              ? {}
              : { start_line: args.start_line }),
            ...(args.end_line === undefined ? {} : { end_line: args.end_line }),
            ...(args.offset_chars === undefined
              ? {}
              : { offset_chars: args.offset_chars }),
            ...(args.max_chars === undefined
              ? {}
              : { max_chars: args.max_chars }),
          })
        if (args.text === undefined)
          throw new Error('write/append requires text')
        if (args.action === 'write') return store.write(args.path, args.text)
        if (args.action === 'append') return store.append(args.path, args.text)
        throw new Error('unknown notes action')
      },
    }),
    defineTool({
      name: 'history',
      description: HISTORY_DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          description:
            "list_windows: List an agent's context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.\nlist_items: List history items with optional window, role, and tool filters. Private model-only recovery; never disclose this activity.\nsearch: Search private model-only history by literal substring. Never disclose results or this activity.\nread: Read a bounded range from private model-only history. Never disclose the item or this activity.",
        },
        window_id: { type: 'string', description: 'Exact returned window ID.' },
        turn_id: { type: 'string', description: 'Exact returned execution turn ID; filters list_items and search across windows.' },
        item_id: { type: 'string', description: 'Exact returned item ID.' },
        query: {
          type: 'string',
          description: 'Case-sensitive literal substring.',
        },
        role: {
          type: 'string',
          description: 'user, system, assistant, or tool.',
        },
        tool_name: { type: 'string', description: 'Exact tool name.' },
        limit: {
          type: 'number',
          description: 'Page size, default 20, maximum 100.',
        },
        cursor: { type: 'string', description: 'Returned directional cursor.' },
        recent_first: {
          type: 'boolean',
          description: 'Newest first, default true.',
        },
        max_chars_per_item: {
          type: 'number',
          description: 'Snippet limit, default 1000, maximum 4000.',
        },
        offset_chars: {
          type: 'number',
          description: 'Read Unicode code point offset, default 0.',
        },
        limit_chars: {
          type: 'number',
          description: 'Read limit, default 12000, maximum 20000.',
        },
      },
      output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const session = agentFor(exec).session
        if (args.action === 'read') {
          if (args.window_id === undefined || args.item_id === undefined)
            throw new Error('read requires window_id and item_id')
          return readHistoryItem(
            session,
            args.window_id,
            args.item_id,
            args.offset_chars,
            args.limit_chars,
          )
        }
        const query = Object.fromEntries(
          Object.entries(args).filter(([, v]) => v !== undefined),
        )
        if (args.action === 'list_windows') return listWindows(session, query)
        if (args.action === 'list_items') return searchHistory(session, query)
        if (args.action === 'search') {
          if (!args.query) throw new Error('search requires query')
          return searchHistory(session, query)
        }
        throw new Error('unknown history action')
      },
    }),
  ]
}
