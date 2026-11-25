export { stripItemId as stripContextItemId } from './item-id.ts'
import { markInputs, markToolResults } from './item-id.ts'
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
import type { Agent, ModelSelection, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  boundContextSummary,
  createUserMessage,
  createSystemMessage,
  type ContextFormed,
} from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import {
  CONTEXT_MANAGEMENT_GUIDANCE,
  FALLBACK_PROMPT,
  REMINDER_TEMPLATE,
} from './guidance.ts'
import { NotesStore } from './notes.ts'
import { currentWindow, normalizedItems } from './history.ts'
import { windowText } from './checkpoint.ts'
import type { RolloverReason } from './checkpoint.ts'
import { commitRollover, selectRolloverRange } from './rollover.ts'
import { createRolloverTools } from './tools.ts'
import { budget } from './budget.ts'
import type { BudgetModelContext } from './budget.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
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
    ctx.on(
      'agent/pre-step',
      async ({ agent, signal, modelSelection }, next): Promise<PreStepDecision> => {
        let decision = await next()
        if (
          decision.kind === 'reject' ||
          signal.aborted ||
          this.ownedElsewhere(agent)
        )
          return decision
        decision = { ...decision, messages: markInputs(agent.session, decision.messages) }
        const assembly = await this.assembleFor(agent, signal, modelSelection)
        const modelContext = await this.resolveBudgetContext(
          agent,
          signal,
          modelSelection,
        )
        let reason: RolloverReason | undefined = this.pendingRollovers.has(
          agent.session.id,
        )
          ? 'model-requested'
          : undefined
        const header = this.header(agent, assembly, modelSelection)
        const systemMessage = createSystemMessage(renderPrompt(assembly))
        const measure = () =>
          budget(
            agent,
            ctx.tokenMeter,
            this.config,
            decision.messages,
            header,
            systemMessage,
            modelContext,
          )
        let reading =
          modelContext === undefined
            ? undefined
            : reason
              ? measure()
              : this.prunePressure(agent, measure)
        if (reading && reading.T >= reading.H) reason ??= 'pressure'
        if (!reason) {
          markToolResults(agent.session, ctx.tokenMeter)
          if (reading) reading = measure()
          if (reading && reading.T >= reading.H) reason = 'pressure'
        }
        if (reason) {
          this.pendingRollovers.delete(agent.session.id)
          await this.perform(
            agent,
            reason,
            signal,
            assembly,
            'current-turn',
            undefined,
            modelSelection,
            modelContext,
          )
          return {
            ...decision,
            messages: markInputs(agent.session, decision.messages.filter(
              (m) => m.source.kind !== 'runtime-context',
            )),
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
                ? FALLBACK_PROMPT
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

  /** Resolve the step's active model selection across live AgentModel and synthetic carriers. */
  private selectionOf(
    agent: Agent,
    explicit?: Readonly<ModelSelection>,
  ): Readonly<ModelSelection> | undefined {
    if (explicit !== undefined) return explicit
    const current = (agent as Partial<Agent>).model?.current()
    if (current !== undefined) return current
    const header = agent.session.requestHeader()?.config
    const provider = header?.provider ?? agent.options.provider
    const model = header?.model ?? agent.options.model
    if (!provider || !model) return undefined
    const reasoningEffort =
      header?.reasoningEffort ?? agent.options.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }
  }

  /** Assemble prompt and admitted tool schemas using the same step admission contract as AgentLoop. */
  private async assembleFor(
    agent: Agent,
    signal: AbortSignal,
    explicitSelection?: Readonly<ModelSelection>,
  ): Promise<PromptAssembly> {
    const modelSelection = this.selectionOf(agent, explicitSelection)
    if (modelSelection === undefined) {
      return this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    }
    const toolSet = await this.ctx.tools.resolve({
      agent,
      modelSelection,
      signal,
    })
    try {
      return await this.ctx.systemPrompt.assemble({
        ...assembleContextFor(agent, signal),
        modelSelection,
        toolSet,
      })
    } finally {
      toolSet.dispose()
    }
  }

  /** Resolve context window metadata for the step's target model when switching routes before a request. */
  private async resolveBudgetContext(
    agent: Agent,
    signal: AbortSignal,
    explicitSelection?: Readonly<ModelSelection>,
  ): Promise<BudgetModelContext | undefined> {
    const persisted = agent.session.requestContext()
    const selection = this.selectionOf(agent, explicitSelection)
    if (
      selection === undefined ||
      (persisted !== undefined &&
        persisted.provider === selection.provider &&
        persisted.model === selection.model)
    ) {
      return persisted
    }
    if (persisted === undefined && agent.session.surface.nodes.length === 0) {
      return undefined
    }
    try {
      const info = await this.ctx.llm.resolveModelInfo(
        selection.provider,
        selection.model,
        signal,
      )
      const contextWindow = info.context?.contextWindow
      if (contextWindow === undefined) return persisted
      return {
        provider: selection.provider,
        model: selection.model,
        contextWindow,
        ...(info.systemPromptUpdate === undefined
          ? {}
          : { systemPromptUpdate: info.systemPromptUpdate }),
      }
    } catch {
      return persisted
    }
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
  private header(
    agent: Agent,
    assembly: PromptAssembly,
    explicitSelection?: Readonly<ModelSelection>,
  ): EpochHeader {
    const prev = agent.session.requestHeader()
    const { tools: _prevTools, ...prevRest } = prev ?? {}
    const selection = this.selectionOf(agent, explicitSelection)
    const provider =
      selection?.provider ?? prev?.config.provider ?? agent.options.provider ?? ''
    const model =
      selection?.model ?? prev?.config.model ?? agent.options.model ?? ''
    const reasoningEffort =
      selection !== undefined
        ? selection.reasoningEffort
        : (prev?.config.reasoningEffort ?? agent.options.reasoningEffort)
    const maxTokens = prev?.config.maxTokens ?? agent.options.maxTokens
    const {
      provider: _p,
      model: _m,
      reasoningEffort: _r,
      maxTokens: _t,
      ...restControls
    } = prev?.config ?? {}
    return {
      ...prevRest,
      config: {
        ...restControls,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      },
      ...(assembly.tools.length > 0 ? { tools: [...assembly.tools] } : {}),
    }
  }
  private async perform(
    agent: Agent,
    reason: RolloverReason,
    signal: AbortSignal,
    provided?: PromptAssembly,
    owner: 'current-turn' | null = 'current-turn',
    sourceCommandId?: CommandId,
    explicitSelection?: Readonly<ModelSelection>,
    explicitModelContext?: BudgetModelContext,
  ): Promise<CompactionResult> {
    signal.throwIfAborted()
    if (reason === 'overflow') this.ctx.get('toolResultPruner')?.pruneSession(agent.session)
    const assembly =
      provided ??
      (await this.assembleFor(agent, signal, explicitSelection))
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
    const modelContext =
      explicitModelContext ??
      (await this.resolveBudgetContext(agent, signal, explicitSelection))
    if (modelContext)
      budget(
        agent,
        this.ctx.tokenMeter,
        this.config,
        [],
        this.header(agent, assembly, explicitSelection),
        createSystemMessage(renderPrompt(assembly)),
        modelContext,
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
          // The next request receives its own current runtime-context snapshot.
          runtimeContext: '',
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
    const modelContext = await this.resolveBudgetContext(agent, signal)
    if (!modelContext) return null
    const assembly = await this.assembleFor(agent, signal)
    const header = this.header(agent, assembly)
    const systemMessage = createSystemMessage(renderPrompt(assembly))
    const reading = this.prunePressure(agent, () =>
      budget(
        agent,
        this.ctx.tokenMeter,
        this.config,
        [],
        header,
        systemMessage,
        modelContext,
      ),
    )
    if (reading.T < reading.H) return null
    return this.perform(
      agent,
      'pressure',
      signal,
      assembly,
      'current-turn',
      undefined,
      undefined,
      modelContext,
    )
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
