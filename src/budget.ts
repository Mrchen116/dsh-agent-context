import type { Agent } from '@deepseek-ai/dsh-agent'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedRolloverConfig } from './config.ts'
/** Estimate budget at the specified public admission seam, replacing the header rather than double counting tools. */
export function budget(
  agent: Agent,
  meter: TokenMeter,
  config: ResolvedRolloverConfig,
  messages: readonly UserMessage[] = [],
  header?: EpochHeader,
  systemMessage?: Message,
) {
  const session = agent.session
  const context = session.requestContext()
  const C = context?.contextWindow
  const O =
    header?.config.maxTokens ??
    session.requestHeader()?.config.maxTokens ??
    agent.options.maxTokens
  if (
    C === undefined ||
    O === undefined ||
    !Number.isFinite(C) ||
    !Number.isFinite(O) ||
    C <= O ||
    O <= 0
  )
    throw new Error(
      'agent-context: valid model contextWindow and maxTokens output reserve are required',
    )
  const model = `${context?.provider}:${context?.model}`
  const override = config.models?.[model] ?? {}
  const H = C - O
  const B =
    override.bufferTokens ??
    config.bufferTokens ??
    Math.min(16384, Math.floor(H * 0.15))
  const W = H - B
  const R =
    override.reminderTokens ??
    config.reminderTokens ??
    Math.min(6144, Math.floor(W * 0.1))
  if (!(0 < R && R < W && W < H))
    throw new Error(
      'agent-context: budget requires 0 < reminderTokens < work limit < input hard limit',
    )
  const measurement = meter.measure(session, header)
  const surface = session.deriveMessages()
  const persisted = new Set(surface.map((m) => m.id))
  const previousSystem = surface.findLast((m) => m.role === 'system')
  const effectiveSystem = systemMessage ?? previousSystem
  const runtime = [...surface, ...messages].findLast((m) =>
    ['runtime-context', 'compact-checkpoint'].includes(m.source.kind),
  )
  const fixedTokens =
    estimateToolsTokens(header ?? session.requestHeader()) +
    (effectiveSystem ? meter.estimateMessage(effectiveSystem) : 0) +
    (runtime ? meter.estimateMessage(runtime) : 0)
  if (fixedTokens >= W)
    throw new Error(
      'agent-context: fixed system/tools/runtime context exceeds work budget',
    )
  const systemDelta = systemMessage
    ? meter.estimateMessage(systemMessage) -
      (previousSystem ? meter.estimateMessage(previousSystem) : 0)
    : 0
  const T =
    measurement.totalTokens +
    systemDelta +
    messages
      .filter((m) => !persisted.has(m.id))
      .reduce((n, m) => n + meter.estimateMessage(m), 0)
  return {
    fixed_tokens: fixedTokens,
    remaining: Math.max(0, W - T),
    T,
    W,
    H,
    C,
    O,
    B,
    R,
    estimated: true,
    measurement: messages.length
      ? 'pre-step persisted surface plus pending inputs; current assembly header'
      : 'persisted-surface',
    baseline: measurement.baseline.kind,
  }
}
