import { Context, symbols } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  ManualCompactionError,
} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {
  CompactionResult,
  CompactionTrigger,
} from '@deepseek-ai/dsh-compaction'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  boundContextSummary,
  createUserMessage,
  createSystemMessage,
} from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  renderContextSnapshot,
  renderPrompt,
} from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import {
  CONTEXT_MANAGEMENT_GUIDANCE,
  FALLBACK_PROMPT,
  REMINDER_TEMPLATE,
} from './guidance.ts'
import { NotesStore } from './notes.ts'
import { currentWindow, referenceText, normalizedItems } from './history.ts'
import { windowText } from './checkpoint.ts'
import type { RolloverReason } from './checkpoint.ts'
import { commitRollover, selectRolloverRange } from './rollover.ts'
import { createRolloverTools } from './tools.ts'
import { budget } from './budget.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-context': { kind: 'agent-context'; form: 'notice'; summary: string }
  }
}
export const name = 'agent-context'
const CONTEXT_NAME = 'agent-context:references'
interface AgentPresetRoster {
  serviceFor(
    agent: { ctx: Context },
    name: 'compaction',
  ): CompactionEngine | undefined
}
function rosterOf(ctx: Context): AgentPresetRoster | undefined {
  return (
    ctx as unknown as { get(name: string): AgentPresetRoster | undefined }
  ).get('agentPresets')
}
function concrete(engine: CompactionEngine): CompactionEngine {
  return (
    (engine as CompactionEngine & { [symbols.original]?: CompactionEngine })[
      symbols.original
    ] ?? engine
  )
}
export type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
export { NotesStore } from './notes.ts'
export {
  createHistoryView,
  collectHistory,
  readHistoryItem,
  searchHistory,
  currentWindow,
} from './history.ts'
export type { HistoryView, HistoryQuery, HistoryItem, WindowInfo } from './history.ts'
export {
  commitRollover,
  countRollovers,
  selectRolloverRange,
} from './rollover.ts'
export { createRolloverTools } from './tools.ts'

/** Scoped deterministic compaction using only the public DSH runtime interfaces. */
export class ContextRolloverEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']
  static Config = Config
  readonly config: ResolvedRolloverConfig
  private readonly pendingRollovers = new Set<string>()
  private readonly assemblies = new WeakMap<Agent, PromptAssembly>()
  constructor(ctx: Context, config: RolloverConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.modelSurface === 'always' || rosterOf(ctx) === undefined) {
      for (const tool of createRolloverTools({
        config: this.config,
        meter: ctx.tokenMeter,
        pendingRollovers: this.pendingRollovers,
        compactionOwnedElsewhere: (a) => this.ownedElsewhere(a),
      }))
        ctx.tools.register(tool)
      ctx.systemPrompt.section({
        name: 'context:agent-context',
        order: 2350,
        text: CONTEXT_MANAGEMENT_GUIDANCE,
      })
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: 2350,
        text: ({ agent }) =>
          agent
            ? windowText(agent.session)
            : '',
      })
    }
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      const agent = context.agent
      if (agent && !this.ownedElsewhere(agent)) {
        this.assemblies.set(agent, assembly)
      }
      return assembly
    })
    ctx.on(
      'agent/pre-step',
      async ({ agent, signal }, next): Promise<PreStepDecision> => {
        const decision = await next()
        if (
          decision.kind === 'reject' ||
          signal.aborted ||
          this.ownedElsewhere(agent)
        )
          return decision
        const assembly =
          this.assemblies.get(agent) ??
          (await ctx.systemPrompt.assemble(assembleContextFor(agent, signal)))
        let reason: RolloverReason | undefined = this.pendingRollovers.has(
          agent.session.id,
        )
          ? 'model-requested'
          : undefined
        const measure = () => budget(
          agent,
          ctx.tokenMeter,
          this.config,
          decision.messages,
          this.header(agent, assembly),
          createSystemMessage(renderPrompt(assembly)),
        )
        const reading =
          agent.session.requestContext() === undefined
            ? undefined
            : reason ? measure() : this.prunePressure(agent, measure)
        if (reading && reading.T >= reading.H) reason ??= 'pressure'
        if (reason) {
          this.pendingRollovers.delete(agent.session.id)
          await this.perform(agent, reason, signal, assembly)
          return {
            ...decision,
            messages: decision.messages.filter(
              (m) => (m.source.kind as string) !== 'runtime-context',
            ),
            startsRequestSeries: true,
          }
        }
        if (reading) {
          const marker =
            reading.T >= reading.W
              ? 'fallback'
              : reading.T >= reading.W - reading.R
                ? 'reminder'
                : undefined
          if (marker && !this.delivered(agent.session, marker)) {
            const text =
              marker === 'fallback'
                ? `${FALLBACK_PROMPT}\n${referenceText(agent.session)}`
                : REMINDER_TEMPLATE.replace(
                    '{n_remaining}',
                    String(reading.remaining),
                  )
            return {
              ...decision,
              messages: [
                ...decision.messages,
                createUserMessage({
                  content: [{ type: 'text', text }],
                  source: {
                    kind: 'agent-context',
                    form: 'notice',
                    summary: boundContextSummary(marker),
                  },
                }),
              ],
            }
          }
        }
        return decision
      },
    )
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      if (
        signal.aborted ||
        this.ownedElsewhere(agent) ||
        !this.pendingRollovers.delete(agent.session.id)
      )
        return
      await this.perform(agent, 'model-requested', signal)
    })
    ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
      if (
        signal.aborted ||
        failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE ||
        this.ownedElsewhere(agent)
      )
        return next()
      const generation = agent.session.surface.replaceGeneration
      try {
        await this.perform(agent, 'overflow', signal)
      } catch (error) {
        ctx.logger.warn(`context overflow recovery failed: ${String(error)}`)
        return next()
      }
      return agent.session.surface.replaceGeneration > generation
        ? { kind: 'retry' }
        : next()
    })
  }
  /** Reuse the host's native pruning transaction before spending the fallback reserve. */
  private prunePressure(agent: Agent, measure: () => ReturnType<typeof budget>) {
    const reading = measure()
    const pruner = this.ctx.get('toolResultPruner')
    if (reading.T < reading.W || pruner === undefined) return reading
    pruner.pruneSession(agent.session)
    return measure()
  }
  private notes(agent: Agent) {
    return new NotesStore(NotesStore.directoryFor(agent.id, agent.session.id))
  }
  private ownedElsewhere(agent: Agent): boolean {
    const owned = rosterOf(this.ctx)?.serviceFor(agent, 'compaction')
    return owned !== undefined && concrete(owned) !== concrete(this)
  }
  private delivered(session: Session, marker: string): boolean {
    const current = currentWindow(session)
    return session
      .snapshotEvents()
      .some(
        (e) =>
          e.seq > current.end_seq &&
          e.type === 'user/message' &&
          e.data.source.kind === 'agent-context' &&
          e.data.source.summary === marker,
      )
  }
  private header(agent: Agent, assembly: PromptAssembly): EpochHeader {
    return {
      ...agent.session.requestHeader(),
      config: {
        ...agent.options,
        ...agent.session.requestHeader()?.config,
        provider:
          agent.session.requestHeader()?.config.provider ??
          agent.options.provider ??
          '',
        model:
          agent.session.requestHeader()?.config.model ??
          agent.options.model ??
          '',
      },
      tools: assembly.tools,
    }
  }
  private async perform(
    agent: Agent,
    reason: RolloverReason,
    signal: AbortSignal,
    provided?: PromptAssembly,
    owner: 'current-turn' | null = 'current-turn',
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult> {
    signal.throwIfAborted()
    if (reason === 'overflow') this.ctx.get('toolResultPruner')?.pruneSession(agent.session)
    const assembly =
      provided ??
      (await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal)))
    const session = agent.session
    const range = selectRolloverRange(
      session,
      this.ctx.tokenMeter.measure(session),
    )
    if (!range)
      throw new Error(
        'agent-context: no complete paired surface range to replace',
      )
    if (
      !normalizedItems(session).some((item) =>
        range.shadowedSeqs.some((seq) => seq === item.seq),
      )
    )
      throw new Error(
        'agent-context: no conversational progress since the previous window; cannot shrink fixed context',
      )
    const runtimeContext = renderContextSnapshot({
      ...assembly,
      contexts: assembly.contexts.filter((c) => c.name !== CONTEXT_NAME),
    })
    if (session.requestContext())
      budget(
        agent,
        this.ctx.tokenMeter,
        this.config,
        [],
        this.header(agent, assembly),
        createSystemMessage(renderPrompt(assembly)),
      )

    return commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      {
        owner,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        checkpoint: {
          reason,
          previousWindowId: currentWindow(session).window_id,
          notesHint: await this.notes(agent).hint(),
          runtimeContext,
        },
        flush: async () => {
          await this.ctx.sessions.flush(session)
        },
      },
    )
  }
  /** Run pressure/overflow policy through the same native transaction. */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.ownedElsewhere(agent)) return null
    signal.throwIfAborted()
    if (trigger === 'context-overflow')
      return this.perform(agent, 'overflow', signal)
    if (!agent.session.requestContext()) return null
    const reading = this.prunePressure(agent, () => budget(agent, this.ctx.tokenMeter, this.config))
    if (reading.T < reading.H) return null
    return this.perform(agent, 'pressure', signal)
  }
  /** Manually reset an idle Agent under its public maintenance lease. */
  override async compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    if (this.ownedElsewhere(agent)) return null
    return agent
      .runMaintenance(async (agentSignal) =>
        this.perform(
          agent,
          'manual',
          AbortSignal.any([signal, agentSignal]),
          undefined,
          null,
          sourceCommandId,
        ),
      )
      .catch((error) => {
        if (error instanceof ManualCompactionError) throw error
        throw new ManualCompactionError('commit', String(error), {
          cause: error,
        })
      })
  }
  /** Region requests must cover the full paired conversation; partial tail retention is unsupported. */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (this.ownedElsewhere(agent))
      throw new Error('context engine is not active for this Agent')
    const range = selectRolloverRange(
      agent.session,
      this.ctx.tokenMeter.measure(agent.session),
    )
    if (!range || range.start !== start || range.end !== end)
      throw new Error(
        'agent-context requires the complete paired conversation range',
      )
    return this.perform(agent, 'manual', signal ?? new AbortController().signal)
  }
}
export default ContextRolloverEngine
