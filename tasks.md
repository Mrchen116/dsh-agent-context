# Agent context implementation

- [x] Replace upstream tail/handoff contract with paired deterministic full-window transactions.
- [x] Implement session-owned bounded Notes and archive-only History with stable references.
- [x] Add per-window persistent budget notices, fallback reserve, hard-cap and overflow recovery.
- [x] Rebuild current runtime state, remove the host's stale pre-step snapshot, and retain newly claimed inputs.
- [x] Package the isolated model surface against public DSH 0.2.1-alpha.1 as 0.3.0-rc.1.
- [x] Verify public runtime behavior, typecheck, build and pack; hand over to Nano integration owner.

## Test ownership and disposition

| Existing owner | Disposition | Retained / replacement risk |
| --- | --- | --- |
| `tests/notes.spec.ts` | rewrite-merge | Atomic bounded files, verbatim concurrent append, unreadable-file preservation, path/symlink rejection, Unicode line continuation and body-free hints. |
| `tests/history.spec.ts` | rewrite-merge | Archived-only source-preserving content, full tool arguments/results, stable IDs on replay, long Unicode continuation and reference paging. |
| `tests/rollover.spec.ts` | rewrite-merge | Full paired selection after system head, raw-log preservation, strict shrink and bracket lock/failure. |
| `tests/engine.spec.ts` | rewrite-merge | Actual first post-reset request, current policy, pending new input, no old tail/body/identity, three useful same-turn windows. |
| `tests/safety.spec.ts` | rewrite-merge | Multiple hard-cap resets in one turn, actual overflow retry and no fixed-only loop, idle manual reset. |
| `tests/reminder-delivery.spec.ts` | rewrite-merge | Model-visible reminder/fallback once per durable window, fallback references, recreated Session and plugin state. |
| `tests/preset-deferral.spec.ts` | rewrite-merge | Scoped owner deferral, truthful inactive tool failure, explicit model-surface registration. |
| `tests/tools.spec.ts` | rewrite-merge | Public DSH tool execute/render, bootstrap budget unavailability, exact model overrides, session boundaries. |
| `tests/tool-discovery.spec.ts` | rewrite-merge | Approved prompt/schema protocol and no-argument transition tool. |
| `tests/pressure-range.spec.ts` | merge/delete | Full system-head range is protected by rollover/engine tests; old tail premise retired. |
| `tests/web-preset.spec.ts` | delete | Web roster mutation is explicitly outside this package's new contract. |
| `tests/harness.ts` | update | Runs the published public AgentLoop testkit; no private invariant imports or source aliases. |

The exact-text fixtures protect the explicitly approved Codex prompt contract. Runtime tests use real published AgentLoop, Session, Compaction and tool-registry APIs; adapters are scripted and do not claim real-model product acceptance. No speculative compatibility line or parallel legacy-tail suite remains.
