# Implementation evidence

Baseline: upstream `d74876a90968bd5498b5af0bcc2f327c3131f007`; implementation branch `codex/feat-627-agent-context`. Runtime dependencies and CI use published DSH `0.2.1-alpha.1`, Cordis `4.0.5-alpha.1`, and Schemastery `3.18.5-alpha.1`.

## Red to green evidence

- Notes replacement tests against upstream failed on Chinese relative paths, missing Unicode line slices, and a symlink read that returned the external secret. The implemented store passes these cases, literal append/size limits, and the retained unreadable-append regression.
- History recovery test failed because the persisted tool-result metadata tail was omitted. Normalization now preserves full persisted result payloads in addition to readable blocks; the same Unicode-pagination and source-preservation test passes.
- Overflow/manual tests exposed a real fixed-only retry flaw: replacing `initial` with a shorter numeric window ID could satisfy a token shrink check despite no conversational progress. The native engine now refuses a reset when its selected range contains no conversation item, and the tests prove only one successful overflow reset followed by terminal failure.
- The real public AgentLoop request test verifies the first post-reset request contains current runtime policy plus newly steered input, but no previous current-window identity, old tail, or note body. Another same-turn test commits three useful boundaries with seven scripted requests and no summary-model call.
- Hard-cap pressure test commits three boundaries in turn 2; reminder/fallback test reconstructs a fresh Session/plugin and observes no duplicate notice. These are automated runtime observations, not a claim about live model task quality.

## Verification

- `pnpm install --frozen-lockfile`: passed.
- `pnpm peers check`: no peer dependency issues.
- `pnpm typecheck`: passed against published public exports.
- `pnpm test`: 9 files / 21 tests passed (local Node 25.8.2 / pnpm 11.5.2; CI selects Node 24).
- `pnpm pack`: prepack cleans/builds `lib`, producing `dsh-agent-context-0.3.0-rc.1.tgz` with JS, declarations, patch, README and MIT LICENSE only.

## Host handoff

The release candidate version follows the Nano integration owner's instruction; no release, tag, PR, push, or merge is performed by this worker. Nano owns default mounting, authorization and allowlist integration, actual model acceptance, and release publication. Public DSH Agent identity is session-backed, so no Nano preset-name parsing or new trusted identity configuration is introduced.

Resolved output reserve comes from `request/header.config.maxTokens`, where the public loop materializes adapter defaults. The first unresolved request is allowed through normal DSH admission; a direct pre-request budget tool call reports `awaiting_first_request`. Missing C/O after admission is a real model configuration failure.

Configuration: `modelSurface`, `bufferTokens`, `reminderTokens`, and exact `models['provider:model']` B/R overrides. The bundle isolates `compaction` and forces `modelSurface: always`. Notes and History do not accept another Agent/session/root. The host must retain its existing approval and delivery boundaries after retrieval.

The first checkpoint carries an empty current-reference snapshot because the old surface has been removed and newly claimed inputs have not yet received seqs. Subsequent snapshots index active persisted messages only; archive navigation stays in History. The first-request test checks the actual non-system payload so guidance mentioning a tag cannot falsely satisfy the snapshot assertion.
