/** Native paired compaction transactions with deterministic control-state checkpoints. */

import { randomUUID } from 'node:crypto'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionSeq as Seq } from '@deepseek-ai/dsh-session'
import { windows, interruptedTurn } from './history.ts'
import { buildCheckpointText } from './checkpoint.ts'
import type { CheckpointInput } from './checkpoint.ts'

/** The compaction/summary `provider` value written by this backend. */
export const ROLLOVER_PROVIDER = 'dsh-agent-context'

/** Transaction inputs the engine resolves before committing. */
export interface RolloverDependencies {
  readonly meter: TokenMeter
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: Seq
  readonly end: Seq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly Seq[]
}

/** Options for one rollover transaction. */
export interface CommitRolloverOptions {
  /** `current-turn` derives the open turn's number; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Effective runtime state and body-free recovery navigation. */
  readonly checkpoint: CheckpointInput
  /** Manual command that initiated this rollover, when present. */
  readonly sourceCommandId?: CommandId
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
}

/**
 * Select the entire paired conversation after the immutable system head.
 * @param session - Current session surface.
 * @param measurement - Meter snapshot for that surface.
 * @returns Full replaceable span, or null while tool pairing is incomplete.
 */
export function selectRolloverRange(
  session: Session,
  measurement: TokenMeasurement,
): { start: Seq; end: Seq; shadowedSeqs: readonly Seq[] } | null {
  const nodes = session.surface.nodes
  if (
    nodes.length !== measurement.nodes.length ||
    nodes.some((seq, i) => seq !== measurement.nodes[i]?.seq)
  )
    throw new Error('token-meter surface mismatch')
  const first = nodes[0]
  const startIndex =
    first !== undefined && session.eventAt(first)?.type === 'system/message'
      ? 1
      : 0
  const start = nodes[startIndex]
  const end = nodes.at(-1)
  if (
    start === undefined ||
    end === undefined ||
    !toolPairingBalancedBefore(session, start) ||
    !toolPairingBalancedAfter(session, end)
  )
    return null
  return { start, end, shadowedSeqs: nodes.slice(startIndex) }
}

/** Validate one requested surface-position span before committing. */
function validateSurfaceRegion(
  session: Session,
  start: Seq,
  end: Seq,
): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1)
    throw new Error(`rollover: start seq ${start} not found in surface`)
  if (endIdx === -1)
    throw new Error(`rollover: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `rollover: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  const startNode = nodes[startIdx]
  const endNode = nodes[endIdx]
  if (startNode === undefined || endNode === undefined) {
    throw new Error('rollover: span bounds vanished from the surface')
  }
  if (!toolPairingBalancedBefore(session, startNode)) {
    throw new Error(
      `rollover: start seq ${start} is not a balanced boundary (would split a tool-call/result pair)`,
    )
  }
  if (!toolPairingBalancedAfter(session, endNode)) {
    throw new Error(
      `rollover: end seq ${end} is not a balanced boundary (would split an open step)`,
    )
  }
  return {
    start,
    end,
    startIdx,
    endIdx,
    shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
  }
}

/** Entry state: open turn, unmatched compaction lock, and latest end-seed boundary. */
interface RolloverEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart:
    | SessionEvent<'compaction/start'>
    | undefined
  readonly latestEndSeedSeq: Seq | undefined
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state. */
function inspectEntryState(session: Session): RolloverEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: Seq | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.snapshotEvents()[seq]
    if (event === undefined) continue
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (
      openTurnStateKnown &&
      compactionEntryStateKnown &&
      latestEndSeedSeq !== undefined
    )
      break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/**
 * Commit one rollover over a validated span. The compaction lock, shrink
 * guard, provenance coverage, and bracket pairing follow the shared compaction
 * protocol; the summary content is built synchronously from the caller's
 * checkpoint inputs, so the whole body commits without yielding between the
 * lock and the replacement.
 * @param dependencies - the conversation meter used for pricing.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq of the replaced span.
 * @param end - inclusive last surface-node seq of the replaced span.
 * @param options - bracket owner, checkpoint inputs, flush, and command provenance.
 * @returns the durable compaction result.
 */
export async function commitRollover(
  dependencies: RolloverDependencies,
  session: Session,
  start: Seq,
  end: Seq,
  options: CommitRolloverOptions,
): Promise<CompactionResult> {
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectEntryState(session)
  if (
    entryState.unmatchedCompactionStart !== undefined &&
    (entryState.latestEndSeedSeq === undefined ||
      entryState.latestEndSeedSeq <= entryState.unmatchedCompactionStart.seq)
  ) {
    throw new ManualCompactionError(
      'busy',
      'context-rollover: a compaction is already in progress; the session compaction lock is active',
    )
  }

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError(
        'busy',
        'manual rollover: the session already has an open turn',
      )
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error(
        'rollover: no open turn — automatic rollover events must be enclosed in a turn',
      )
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...(options.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: options.sourceCommandId }),
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)

  let result: CompactionResult | undefined
  try {
    // The span is validated, priced, and replaced synchronously — no
    // summarization yield, so no stability recheck is required.
    const measurement = dependencies.meter.measure(session)
    const selectedNodes = measurement.nodes.slice(
      selection.startIdx,
      selection.endIdx + 1,
    )
    if (
      selectedNodes.length !== selection.shadowedSeqs.length ||
      selectedNodes.some(
        (node, index) => node.seq !== selection.shadowedSeqs[index],
      )
    ) {
      throw new Error(
        'rollover: the selected surface changed before the replacement committed',
      )
    }
    const shadowedTokenCount = selectedNodes.reduce(
      (total, node) => total + node.heuristicTokens,
      0,
    )
    const shadowedRouteTokenCount = selectedNodes.reduce(
      (total, node) => total + node.tokens,
      0,
    )

    const checkpointText = buildCheckpointText(
      { ...options.checkpoint, interruptedTurn: interruptedTurn(session, selection.shadowedSeqs) },
      `${session.id}:${startEvent.seq}`,
    )
    const checkpointMessage = createUserMessage({
      content: [{ type: 'text', text: checkpointText }],
      source: compactCheckpointSource(compactionId, options.sourceCommandId),
    })
    const framedTokenCount =
      dependencies.meter.estimateMessage(checkpointMessage)
    if (framedTokenCount >= shadowedRouteTokenCount) {
      throw new Error(
        `rollover checkpoint is not smaller than the shadowed content ` +
          `(${framedTokenCount} estimated tokens >= ${shadowedRouteTokenCount}); ` +
          'the active context is too small for a useful rollover',
      )
    }

    const summaryBlocks: ContentBlock[] = [
      { type: 'text', text: checkpointText },
    ]
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(options.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: options.sourceCommandId }),
      summary: summaryBlocks,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
      provider: ROLLOVER_PROVIDER,
      model: `deterministic/window-${startEvent.seq}`,
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: [
        startEvent.seq,
        summaryEvent.seq,
        ...selection.shadowedSeqs,
      ],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    result = {
      compactionId,
      ...(options.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: options.sourceCommandId }),
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: summaryBlocks,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    }
  } catch (error: unknown) {
    try {
      session.append('compaction/end', {
        ...lifecycle,
        error: errorChain(error),
      })
    } catch {
      // The unmatched start stays durable evidence of the failed attempt; the
      // original failure is the one callers must see.
    }
    throw error
  }

  if (result === undefined)
    throw new Error('rollover committed without a result')
  if (options.flush !== undefined) await options.flush()
  return result
}

/** Number of successful native context boundaries, including other compaction providers. */
export function countRollovers(session: Session): number {
  return windows(session).length - 1
}
