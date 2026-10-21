# dsh-agent-context

A deterministic context-window engine for **DeepSeek Harness 0.2.1-alpha.1**. It replaces the complete paired conversation after the system head with current runtime state and recovery navigation. It makes no summarization call and carries no conversation tail, note bodies, or handoff text into the new window.

Forked from [athif23/dsh-context-rollover](https://github.com/athif23/dsh-context-rollover) at `d74876a90968bd5498b5af0bcc2f327c3131f007`. The original MIT copyright and license remain in [LICENSE](LICENSE). Context guidance and recovery descriptions use the approved adaptations of [OpenAI Codex](https://github.com/openai/codex) commit `464add49587a7cb6032d5ab04faa8a1585947853`; original/adapted golden fixtures are in `tests/prompts/`.

## Install and lifecycle

This repository publishes a prebuilt npm tarball. Install a **fixed release URL**, or unpack a development `pnpm pack` artifact into a normal local directory and install that directory through your host's bundle manager. A local `.tgz` is not a directory. Record the release commit and SHA-256; never replace an existing release asset.

The bundle patch mounts one isolated compaction owner with `modelSurface: always`. It does not disable host compaction, change web presets, or bundle a second DSH/Cordis runtime. The host owns activation, scoped disposal, idle synchronization, and fallback when the bundle is disabled. Package replacement may require a host restart. Disabling does not delete notes or original session events.

```yaml
- insert:
    - id: agent-context
      name: dsh-agent-context
      isolate:
        compaction: true
      config:
        modelSurface: always
```

Use the host's `plugin_manager` bundle operations when available. Installing the files is distinct from successfully mounting the service and tools. Native consumers may mount the default exported engine in an isolated Agent scope directly.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `modelSurface` | `auto` | `always` mounts four tools and guidance even when a preset roster exists. `auto` defers model-surface registration in roster deployments. |
| `outputReserveTokens` | `min(32768, floor(C * 0.25))` | Budget-only output reserve when the resolved request has no maxTokens; does not alter the provider request. |
| `bufferTokens` | `min(16384, floor(H * 0.15))` | Positive integer fallback reserve, B. |
| `reminderTokens` | `min(6144, floor(W * 0.1))` | Positive integer reminder distance, R. |
| `models` | `{}` | Exact `provider:model` keys with optional `outputReserveTokens` / `bufferTokens` / `reminderTokens` overrides. |

The effective model context window is C; an explicit resolved request-header `maxTokens` is the output reserve O (including adapter defaults). When the request legitimately has no cap, O uses the configured budget-only reserve or the table default. Budget reads label `output_reserve_source` as `request-maxTokens` or `policy-estimate`; the latter does not claim to know the provider output limit. H = C − O; W = H − B. Configuration must satisfy `0 < R < W < H`. Missing C, invalid explicit caps/reserves and fixed input that cannot fit W are explicit errors. Before the first resolved request exists, the engine leaves ordinary first-step admission to DSH. A budget tool call before any request reports `measurement: awaiting_first_request` and null numeric headroom; subsequent budget reads are estimates, not provider token counts.

At W − R the engine sends one reminder per window; at W it sends one save-notes fallback with current committed references. At H or provider overflow it resets at a safe native boundary. Reminder/fallback delivery is reconstructed from the durable log after restart. Multiple windows may occur in one turn. A fixed-only context cannot keep resetting without conversational progress.

## Model tools

- `new_context({})`: records a request for the next paired safe boundary. The result is `requested`, not a claim that compaction already succeeded.
- `get_context_remaining({references_cursor?})`: returns current `window_id`, `remaining`, T/W/H/C/O/B/R, `estimated`, measurement provenance, and a reference page. A tool invocation can see just-admitted messages already persisted before that tool executes.
- `notes({action, ...})`: `list`, `read`, `search`, `write`, `append` within the owning Agent session.
- `history({action, ...})`: `list_windows`, `list_items`, `search`, `read` for messages that have left the active surface.

### Notes

Storage is `<DSH home>/agent-context/<encoded-agent-id>/<encoded-session-id>/notes`. Agent identity here is the public DSH session-backed `Agent.id`, not a Nano business-agent name or a parsed preset identifier. Host `DSH_HOME` determines the home; tools cannot choose another Agent, session, or root. Fresh/fork sessions have their own namespace. This version does not migrate the upstream store.

`list` and `search` accept `path_prefix`, `limit` (20, maximum 100), and `cursor`. Listing returns path, UTF-8 byte size, mtime and `next_cursor`, sorted by descending mtime then path. Search is a case-sensitive literal substring search with bounded line snippets.

`read` accepts `path`, inclusive `start_line` (1 by default), `end_line`, `offset_chars` within the starting line, and `max_chars` (12000, maximum 20000). It returns content, `truncated`, `next_line`, and `next_offset_chars`, so even a single oversized line is recoverable. Character offsets count Unicode code points.

`write` atomically replaces a file; `append` appends exactly the supplied text and creates a missing file. Same-file writes serialize. Both return only after the mutation succeeds. Files are limited to 1,000,000 UTF-8 bytes. Invalid relative paths, symbolic links, missing reads, invalid slices, and oversized writes fail explicitly. This is a trusted local plugin's file boundary, not an OS sandbox.

Automatic hints contain at most five recent paths and 4000 UTF-8 bytes; bodies are available only through explicit reads.

### History and references

Native successful compaction brackets define window IDs: `<session-id>:initial`, then `<session-id>:<compaction-start-seq>`. Item IDs are persisted event sequence numbers. Display ordinals do not change the identity. Failed/unclosed brackets do not create windows; other compaction providers' successful brackets do. Session replay reproduces the same references.

History preserves original provenance, full tool arguments and persisted result payloads, including metadata. `nano-human` is human input; `nano-system` remains system material; Inbox results remain tool results with their nested provenance. Failed assistant attempts are excluded. Reads reject active items and cross-session references.

List/search accept `window_id`, `role`, `tool_name`, `recent_first` (true), `limit` (20, maximum 100), and a directional `cursor`. Item snippets use `max_chars_per_item` (1000, maximum 4000). `read` requires `window_id` and `item_id`, with `offset_chars` (0) and `limit_chars` (12000, maximum 20000), returning `total_chars`, `next_offset_chars`, and `truncated`.

The `get_context_remaining` reference page of currently active persisted messages provides at most 32 references and 4000 bytes. It is queried on demand; ordinary steps and Notes writes do not change the runtime prompt. The exhausted-window fallback also includes a reference snapshot. A full reset starts with an empty reference snapshot; archived items are addressed through History. Recovery records are evidence, never new authorization. Existing approvals and delivery revalidation remain the host's responsibility.

## Development and packaging

Node 24 and pnpm 11.5.2 are used by CI. Build and tests resolve published DSH packages, without a sibling source checkout, generated private paths, or host-version probes.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack
shasum -a 256 dsh-agent-context-0.3.0-rc.1.tgz
```

The real public AgentLoop tests protect paired native transactions, first-request runtime reconstruction, repeated pressure resets, bounded overflow retry, restored reminder state, Notes boundaries, complete archived recovery, and scoped model-surface ownership. Host integration and an actual long model task remain separate acceptance work.


### Interrupted work recovery

History items expose `turn_id`, the owning native `turn/start` event sequence as an opaque string (or null outside a turn). `history` actions `list_items` and `search` accept an exact `turn_id` filter across archived windows of the current session.

When a reset removes messages from the currently open turn, its durable checkpoint includes a body-free `<interrupted_turn>` with bounded item references and a paginated History query. The model must recover original inputs and prior deliveries before continuing or concluding: existing Notes may predate a newly read Inbox task. An idle manual reset does not invent interrupted work. Runtime environment reconstruction remains in the native compaction transaction; only window identity changes its ordinary context contribution.

These on-demand reference and interrupted-turn instructions adapt the Codex baseline for DSH's cumulative runtime snapshots. Golden fixtures retain the original text and record the changed adaptation; they do not claim that this recovery protocol is verbatim upstream Codex behavior.
