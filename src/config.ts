import z from '@deepseek-ai/schemastery'
export interface BudgetOverride {
  outputReserveTokens?: number
  bufferTokens?: number
  reminderTokens?: number
}
export interface RolloverConfig extends BudgetOverride {
  modelSurface?: 'auto' | 'always'
  models?: Record<string, BudgetOverride>
}
export const Config: z<RolloverConfig> = z.object({
  modelSurface: z.union(['auto', 'always'] as const),
  outputReserveTokens: z.number().step(1).min(1),
  bufferTokens: z.number().step(1).min(1),
  reminderTokens: z.number().step(1).min(1),
  models: z.dict(
    z.object({
      outputReserveTokens: z.number().step(1).min(1),
      bufferTokens: z.number().step(1).min(1),
      reminderTokens: z.number().step(1).min(1),
    }),
  ),
})
export type ResolvedRolloverConfig = RolloverConfig & {
  modelSurface: 'auto' | 'always'
}
/** Validate explicit token budgets; window-relative defaults are resolved per model. */
export function resolveConfig(config: RolloverConfig): ResolvedRolloverConfig {
  if (
    config.modelSurface !== undefined &&
    config.modelSurface !== 'auto' &&
    config.modelSurface !== 'always'
  )
    throw new Error('modelSurface must be auto or always')
  for (const entry of [config, ...Object.values(config.models ?? {})]) {
    for (const n of [
      entry.outputReserveTokens,
      entry.bufferTokens,
      entry.reminderTokens,
    ])
      if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0))
        throw new Error('budget overrides must be positive integers')
  }
  return { ...config, modelSurface: config.modelSurface ?? 'auto' }
}
