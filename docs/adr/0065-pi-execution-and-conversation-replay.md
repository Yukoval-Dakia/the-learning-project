---
status: accepted
---

# Pi execution, native provider presets and conversation replay

This records the already approved and delivered migration, not a new runtime
policy. Owner's 2026-09-18 direction is recorded in the
[migration design](../design/2026-09-18-pi-agent-execution-adapter.md); YUK-921
P0–P4 culminated in [YUK-1025 / PR #1435](https://github.com/Yukoval-Dakia/the-learning-project/pull/1435).
The 2026-10-03 instruction to migrate and remove the old compatibility routes
is recorded in [YUK-1007's native-provider delivery](../planning/2026-10-03-yuk1007-native-pi-providers.md).
Pi 1.0 transcript/turn adaptation is recorded in
[YUK-1112](../planning/2026-10-03-yuk1112-pi-1.md).
Current source was checked at main `8ecb4f64` on 2026-10-04 for YUK-1119.

## Execution and provider identity

`PiAgentAdapter` is the sole `ExecutionAdapter` for chat/agent tasks. It delegates
the model/tool loop to `@earendil-works/pi-agent-core`'s `agentLoop`; Claude Agent
SDK and its subprocess/settings/session-file runtime are retired. Typed tasks
retain their separate typed execution contracts: this does not route Jev or all
non-runner model traffic through pi.

`pi-models.ts` uses pi's `builtinModels()` without rebuilding compatibility
providers. Provider/model selection chooses the actual native catalog model,
protocol, compat flags, authentication and headers. Xiaomi and `zai-coding-cn`
use their native presets; `anthropic-sub` is an authentication lane mapped to
native `anthropic`, not another protocol implementation. OpenCode Go uses the
exact `opencode-go` preset, including its User-Agent behavior. The adapter adds
`x-opencode-session` from the attempt's task-run identity. Swapping only URL/key
does not implement provider switching. Old Xiaomi/Zhipu Anthropic-compatible
registrations are removed; active configuration migration does not rewrite
historical runs or itself perform a deployment.

Capability-owned TaskSpecs and DomainTools still own product operations. Pi tools
delegate to `executeDomainToolCall` for permissions, cancellation, validation and
audit. `piHooks`, `piToolMounts`, `piAgents` and supplied `piSkillDocs` replace SDK
hooks, MCP descriptors, agent descriptors and filesystem skill loading. Retained
`sdk-types.ts`/`SDKMessage` names describe the normalized frame contract; they are
not a second execution engine. Pi 1.0 `finishTurn` enforces the existing turn
budget; a clean terminal answer at the limit is distinct from a tool-calling turn
that would need another iteration.

## Persistent conversation and history

[ADR-0062](./0062-unified-copilot-conversation-lifecycle.md) remains the product
lifecycle: durable acceptance, sequential messages, reconnectable observation
and explicit Stop. There is no foreground/Mission conversation split. Sequential
acceptance is not immediate steering; pi queue hooks alone do not prove a caller.

The existing `agent_sdk_session_id` column stores a `pi:<uuid>` cursor. The
worker's process-local ownership/context-delivery map determines whether to reuse
it. A cursor is not a provider session file or proof of shared cross-process
storage. On resume, `copilot-execution.ts` supplies bounded durable turns through
`piSessionReplay`; the adapter seeds `context.messages`. Cold execution already
folds history into its prompt and does not seed that history a second time.
Therefore the old SDK rule “history is never replayed on resume” no longer
describes transport behavior. Replayed turns are not new billable usage records,
but the provider still receives model context; no zero-token resume is claimed.

Each execution still obeys admission, cancellation, fences, budget and audited
terminal handling. A restored cursor does not authorize replaying paid work.
Current learner state is supplied each turn; proposal feedback retains bounded
digest-based delivery. Copilot owns correction binding and final persisted reply
bytes, including cursor invalidation when required by reply finalization.

## Context pruning, not a model-generated summary

`PiAgentAdapter.makeTransformContext` implements the `nativeCompaction` option.
Before model calls, a text/CJK token estimate triggers pruning above 85% of the
model context window, targeting 60%. It reconstructs current system instructions
and tool declarations via pi 1.0 `getCurrentSystemMessage`, reinjects bounded
session context, and retains the newest history tail. Older messages are dropped;
this is deterministic pruning, not Claude's native summary generation.

Repeated context injections are replaced; leading orphan tool results are removed.
The latest message is retained even when large, so the target is not an absolute
size guarantee. Transform failures pass through original context. Neither case
is proof that a provider request will fit its context window. `compact_boundary`
records bounded trigger/pre/post context metadata, not raw reasoning or a new
billable-usage counter. Pruning never resets permission, deadline or turn budgets.
This mechanism does not establish full SDK semantic equivalence, real-model
summary quality or production cost savings.

## Children, costs and retained history

Native research is a depth-one nested pi loop returning a tool result to its
original parent; it does not mint an automatic paid root continuation. Child
usage is included in the parent's terminal aggregate. Pi catalog costs are
`estimated` with `pi-catalog:<provider>/<model>` provenance, not provider-reported
bills or actual subscription-quota deductions.

[ADR-0063](./0063-retire-copilot-mailbox-execution.md) still governs the retired
mailbox path, installation drain requirements, retained native child projection,
historical rows and the live remote ToolOperations owner. Retained SQL/wire names
do not authorize deleted handlers or a universal table rename. Historical
`copilot_continuation` and retired `copilot_subagent_reconcile` are distinct from
the live `copilot_run_reconcile` recovery path.

## Supersession and limits

This supersedes SDK-specific mechanisms in ADR-0003/0004/0041/0054–0058/0060 and
SDK wording in ADR-0062/0063. Existing product, safety, data-retention and learning
decisions remain subject to their later explicit amendments; this is not blanket
confirmation of every historical statement. ADR-0059's goal-lock ordering is
unrelated and unchanged. No dependency upgrade, runtime change, production
operation, new paid evaluation or night-agent activation is part of this record.

Current implementation guide: [server/ai AGENTS](../../src/server/ai/AGENTS.md).
Relevant source: `src/server/ai/{execution-adapter,pi-agent-adapter,pi-models}.ts`,
`src/capabilities/copilot/server/{copilot-execution,copilot-worker-session}.ts`,
and `src/server/ai/tools/{pi-tools,pi-subagent}.ts`.
