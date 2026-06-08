// Wave 5 / T-D3/C — Copilot Drawer chat (two-surface routing).
//
// Single entry point for both surfaces:
//
//   • Default chat (`triggered_by='chat'`)
//       allowlist  : 'copilot'                  (reader + propose_knowledge_edge)
//       writes     : experimental:copilot_user_ask  (mirror user ask event)
//       agent      : CopilotTask, actor 'agent:copilot'
//
//   • Chip-direct-trigger (`triggered_by='chip'`)
//       allowlist  : 'copilot_user_suggested_mistake_action'
//                    (+ attribute_mistake + propose_variant)
//       writes     : NO user ask event (per Wave 5 T-D3/C contract)
//       agent      : CopilotTask, actor 'agent:copilot_chip'
//
// Mirror tool-use events still flow via mcp-bridge (caller actor is agent).

import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';

import type { Db, Tx } from '@/db/client';
// YUK-198 — Tavily remote MCP (web grounding) for the Copilot surface only.
// Gated on TAVILY_API_KEY: when absent, buildTavilyMcpServer() returns null and
// the Copilot run is byte-for-byte unchanged (no tavily server, no extra tools).
import {
  TAVILY_MCP_ALLOWED_TOOLS,
  TAVILY_MCP_SERVER_NAME,
  buildTavilyMcpServer,
} from '@/server/ai/mcp/tavily';
import {
  type RunTaskResult,
  type StreamCollectResult,
  runAgentTask,
  runTask,
  streamTaskCollecting,
} from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolSurface,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import {
  COPILOT_HISTORY_BUDGET,
  PROPOSAL_FEEDBACK_BUDGET,
  resolveContextBudget,
} from '@/server/ai/tools/budgets';
import { ContextBudgetTracker } from '@/server/ai/tools/context-throttle';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
// YUK-275 — free-text 求卷 (C 形态): zero-LLM 粗筛 + one-LLM 参数解析, routed to the
// existing quiz execution out-port. NO new tool on COPILOT_TOOLS (U6 防循环 red line).
import {
  QUIZ_INTENT_MISSING_KNOWLEDGE_REPLY,
  QUIZ_INTENT_PARSE_FAILED_REPLY,
  detectQuizIntent,
  resolveQuizIntent,
} from '@/server/copilot/quiz-intent';
// AF S4 / YUK-203 U6 — Copilot skills (behavior packs). A skill_context turn
// routes to these at the service layer instead of the free-form CopilotTask loop.
import { type QuizSkillResult, runQuizSkill } from '@/server/copilot/skills/quiz-skill';
// YUK-284 (C3) — solve-skill is no longer imported here: it was extracted from the
// skill_context protocol (chat.ts no longer routes solve). runSolveSkill stays an
// independent service in src/server/copilot/skills/solve-skill.ts for a future
// 题目页 inline入口.
import { type TeachingSkillResult, runTeachingSkill } from '@/server/copilot/skills/teaching-skill';
// YUK-267 (C2) — the SAME session-scoped turn reader the drawer replay uses. The
// free-form run input reuses it to assemble conversation_history (防循环 ①: history
// = persisted ask原文 + reply正文 only). NO new schema, NO new read source.
import { type CopilotTurn, getRecentCopilotTurns } from '@/server/copilot/turns';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// P5.4-L2 / YUK-174 (Facet A, §3.3) — feed the per-(kind, relation) accept-
// learned reason digest into the Copilot run input, EDGE-scoped (Copilot
// proposes knowledge_edge, COPILOT_TOOLS). Explicitly truncated to
// PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars at READ TIME — the ContextBudgetTracker
// gates the tool-call loop, NOT initial-input chars (codex#3). Cold-start inert.
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/server/proposals/adaptive-bias';
// AF S3a / YUK-203 U3 — durable conversation envelope. runCopilotChat now
// find-or-creates a learning_session(type='conversation') so turns persist and
// the drawer can replay-last-N (AF spec §1.5 + §7 S3a). Session ownership stays
// in src/server/session/conversation.ts (ADR-0005 single-owner).
import { Conversation } from '@/server/session';
import {
  type MaterializedAskCheckQuestion,
  materializeAskCheckQuestion,
} from '@/server/teaching/materialize-ask-check';
// YUK-284 (C2) — cross-subject Copilot dialogue-methodology Agent Skill resolver.
// resolveCopilotSkills() returns ['copilot'] when the shared SKILL.md exists, else
// undefined (降级链: free-form ctx omits skills → runner skills ?? [] → systemPrompt
// 散文兜底). Only the free-form CopilotTask token loop loads it; the behavior-pack
// (teaching/solve/quiz) service-call paths do NOT.
import { resolveCopilotSkills } from '@/subjects/copilot-skills';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export const COPILOT_CHAT_TRIGGER_KINDS = ['chat', 'chip'] as const;
export type CopilotChatTriggerKind = (typeof COPILOT_CHAT_TRIGGER_KINDS)[number];

// AF S4 / YUK-203 U6 — the surface-merge behavior-pack selector. A `skill_context`
// turn routes runCopilotChat to a teaching/solve behavior pack (a prompt/context
// pack, NEVER a different tool surface — R5: skill ≠ surface). The behavior packs
// compose TeachingTurnTask at the SERVICE layer; they do not add tools to COPILOT_TOOLS.
//
// YUK-284 (C1) — naming de-overload: these kinds name SERVICE-layer behavior packs
// (TS orchestration), NOT knowledge-layer Agent Skills (SKILL.md). The `skill`
// JSON field name on the wire envelope is intentionally KEPT (the Dock + replay
// persistence depend on it); only the kinds-集合 constant/type identifiers are
// renamed to stop using "skill" for the service编排.
//
// FORWARD-COMPAT NOTE: `skill_context` is the U6-temporary seed of AF S2b's
// `CurrentUserContext.active_ref` (agent-framework-design §1.4). When S2b lands
// the full `active_ref` envelope, this field is subsumed by it — both the `skill`
// discriminator and the `ref` shape are deliberately minimal so the migration is
// additive. The `ref` shape `{ kind, id }` mirrors `leave_agent_note`'s ref
// vocabulary (AF §4 `refs: Array<{kind, id}>`) for consistency.
// YUK-262 — `quiz` added as a third value (was a behavior pack pre-C3).
//
// YUK-284 (C3) — TWO kinds-集合, semantically layered:
//   • COPILOT_SKILL_CONTEXT_KINDS — the WIRE layer: every skill_context.skill value
//     the route may still receive. Stays ['teaching','solve','quiz'] for backward
//     compat: chip quiz still seeds skill_context:{skill:'quiz'} (#348), and a
//     persisted-old solve reply (#solve) must still parse on replay. Used by the
//     z.enum below so CopilotChatRequest.parse never rejects these wire values.
//   • COPILOT_BEHAVIOR_PACK_KINDS — the BEHAVIOR-PACK layer: the kinds that are真
//     LLM/service behavior packs dispatched in chat.ts. C3 收敛为 ['teaching'] only —
//     quiz is intercepted as a service-action (emitQuizReply) BEFORE dispatch, and
//     solve was extracted to an independent service (chat.ts no longer routes it).
export const COPILOT_SKILL_CONTEXT_KINDS = ['teaching', 'solve', 'quiz'] as const;
export type CopilotSkillContextKind = (typeof COPILOT_SKILL_CONTEXT_KINDS)[number];
export const COPILOT_BEHAVIOR_PACK_KINDS = ['teaching'] as const;
export type CopilotBehaviorPackKind = (typeof COPILOT_BEHAVIOR_PACK_KINDS)[number];

export const CopilotSkillContext = z.object({
  // Wire-wide enum (向后兼容 chip quiz + 旧 solve replay); the SERVER classifies which
  // value is a behavior pack vs a service-action vs a降级-fallthrough.
  skill: z.enum(COPILOT_SKILL_CONTEXT_KINDS),
  ref: z.object({
    kind: z.string().min(1).max(40),
    id: z.string().min(1).max(120),
  }),
});
export type CopilotSkillContextT = z.infer<typeof CopilotSkillContext>;

export const CopilotChatRequest = z.object({
  user_message: z.string().min(1).max(4000),
  triggered_by: z.enum(COPILOT_CHAT_TRIGGER_KINDS),
  /**
   * Optional identifier for chip-driven flows, e.g. 'out_3_variants'.
   * Stored on the chip-trigger event so downstream can analyse usage.
   */
  chip_kind: z.string().min(1).max(80).optional(),
  // AF S4 / YUK-203 U6 — optional skill selector. Absent → unchanged free-form
  // Copilot behavior. Present → routes to the teaching/solve skill (§4.4).
  skill_context: CopilotSkillContext.optional(),
  // YUK-267 (C2) — optional ambient context: where the user currently is. Rides
  // ONLY on the per-run input (防循环 ②: never written to any turn payload, never
  // replayed). `route` is the Dock's current page path; `focused_entity` is the
  // in-scope entity (e.g. the active knowledge node), when one exists.
  ambient_context: z
    .object({
      route: z.string().min(1).max(200),
      focused_entity: z
        .object({
          kind: z.string().min(1).max(40),
          id: z.string().min(1).max(120),
        })
        .optional(),
    })
    .optional(),
});

export type CopilotChatRequestT = z.infer<typeof CopilotChatRequest>;

// AF S4 / YUK-203 U6 — structured carrier for a skill turn (teaching ask_check /
// explain / end). Rides as an ADDITIVE optional field on CopilotChatResult so
// the existing text-only consumers are byte-for-byte unaffected; the Dock reads
// it only when present to render the inline question + suggested-next chips.
export interface CopilotSkillTurn {
  kind: 'explain' | 'ask_check' | 'end';
  /** Present only for an ask_check turn that materialized a question. */
  structured_question?: {
    id: string;
    kind: string;
    prompt_md: string;
    choices_md: string[] | null;
  };
  suggested_next?: 'continue' | 'end';
}

export interface CopilotChatResult {
  task_run_id: string;
  reply: string;
  surface: DomainToolSurface;
  triggered_by: CopilotChatTriggerKind;
  /** When the chat path wrote a user_ask event, this carries the id. */
  user_ask_event_id?: string;
  // AF S3a / YUK-203 U3 — durable conversation envelope this turn belongs to,
  // and the persisted reply event id.
  session_id: string;
  reply_event_id: string;
  // AF S4 / YUK-203 U6 — additive optional structured-turn carrier (§4.1). Set
  // only when a teaching skill ran an ask_check/explain/end turn; absent for
  // free-form chat replies so existing consumers are unaffected.
  skill_turn?: CopilotSkillTurn;
  // YUK-266 (C1) — additive optional partial-degrade signal. Set ONLY by the
  // streaming entrypoint when the SDK stream errored mid-flight but some text was
  // still collected and persisted (graceful degrade — the turn is never lost). The
  // non-streaming path never sets it, so existing consumers are unaffected; the
  // Dock surfaces its existing error affordance alongside the partial reply.
  error?: string;
}

const CHIP_TRIGGER_EVENT_ACTION = 'experimental:copilot_chip_trigger';
const USER_ASK_EVENT_ACTION = 'experimental:copilot_user_ask';
// AF S3a / YUK-203 U3 — Copilot reply留痕. New experimental action (NOT in
// RESERVED_EXPERIMENTAL_ACTIONS), so it parses via the generic ExperimentalEvent
// escape hatch — zero schema change. Payload is free-form per ExperimentalEvent
// (z.record). See L-copilot pre-flight缺口表.
const REPLY_EVENT_ACTION = 'experimental:copilot_reply';

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    // YUK-198 — widened to allow remote McpHttpServerConfig (Tavily) alongside
    // the in-process SdkMcpServer (loom). Mirrors runner ctx.mcpServers, which
    // is the SDK's Options['mcpServers'].
    mcpServers?: Record<string, SdkMcpServer | McpHttpServerConfig>;
    allowedTools?: string[];
    // YUK-284 (C2) — Agent Skill whitelist forwarded to the runner (ctx.skills,
    // runner.ts:120). Present on the free-form CopilotTask path so the dialogue
    // methodology SKILL.md loads. The underlying RunTaskCtx already declares
    // skills?: string[]; this alias just exposes it so passing skills here does
    // NOT trip the TS excess-property check.
    skills?: string[];
  },
) => Promise<RunTaskResult>;
// YUK-266 (C1) — swappable streaming agent runner. Streams text deltas to
// `onDelta` then resolves the full StreamCollectResult (text + task_run_id + the
// optional partial/error degrade flags). Defaults to streamTaskCollecting; unit
// tests inject a vi.fn that calls onDelta then resolves a fixture so the {}-stub
// db is never touched. Mirrors RunAgentTaskFn's ctx shape + adds the onDelta arg.
type StreamAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer | McpHttpServerConfig>;
    allowedTools?: string[];
    signal?: AbortSignal;
    // YUK-284 (C2) — see RunAgentTaskFn.ctx.skills. Same forward to the streaming
    // runner so the free-form streaming path loads the copilot SKILL.md too.
    skills?: string[];
  },
  onDelta: (text: string) => void,
) => Promise<StreamCollectResult>;
type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
// YUK-198 — swappable Tavily MCP builder. Defaults to the env-gated
// buildTavilyMcpServer; unit tests inject a fixture (or null) instead of
// touching process.env.
type BuildTavilyMcpServerFn = () => McpHttpServerConfig | null;
// Accepts both Db and Tx so the skill path can call write() inside a db.transaction.
type WriteEventFn = (db: Db | Tx, input: WriteEventInput) => Promise<string>;
// AF S3a / YUK-203 U3 — swappable conversation find-or-create (unit tests inject
// a fixture so the {}-stub db is never touched). Defaults to
// Conversation.findOrCreateCopilotConversation.
type FindOrCreateConversationFn = (
  db: Db,
  opts: { now?: Date },
) => Promise<{ sessionId: string; created: boolean }>;
// P5.4-L2 / YUK-174 (Facet A) — swappable feedback-digest reader (unit tests
// inject a fixture / [] since db is a stub). Defaults to getProposalFeedbackDigest.
type LoadProposalFeedbackFn = (db: Db) => Promise<ProposalFeedbackCell[]>;
// YUK-267 (C2) — swappable conversation-history reader. Defaults to
// getRecentCopilotTurns (the SAME reader the drawer replay uses). Unit tests
// inject a fixture so the {}-stub db is never touched. Session-scoped by
// construction (turns.ts filters by the current reusable conversation).
type LoadHistoryFn = typeof getRecentCopilotTurns;

export interface CopilotChatDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  // YUK-266 (C1) — defaults to streamTaskCollecting. Used ONLY by
  // runCopilotChatStreaming's free-form path; runCopilotChat (non-streaming)
  // ignores it. Unit tests inject a vi.fn so the {}-stub db is never touched.
  streamAgentTaskFn?: StreamAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  // YUK-198 — defaults to buildTavilyMcpServer (reads TAVILY_API_KEY). Returns
  // null when unconfigured → Tavily is not registered and no extra allowedTools
  // are added (back-compat no-op).
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  writeEventFn?: WriteEventFn;
  // P5.4-L2 / YUK-174 — defaults to getProposalFeedbackDigest. The unit test
  // injects [] so the {}-stub db is never queried (cold-start no-op).
  loadProposalFeedbackFn?: LoadProposalFeedbackFn;
  // YUK-267 (C2) — defaults to getRecentCopilotTurns. The unit test injects a
  // fixture so the {}-stub db is never touched. A read failure degrades to [].
  loadHistoryFn?: LoadHistoryFn;
  // AF S3a / YUK-203 U3 — defaults to Conversation.findOrCreateCopilotConversation.
  findOrCreateConversationFn?: FindOrCreateConversationFn;
  // AF S4 / YUK-203 U6 — swappable skill runners (unit tests inject fixtures so
  // the {}-stub db is never touched). Default to the real skill modules.
  // YUK-284 (C3) — runSolveSkillFn seam removed: chat.ts no longer routes solve.
  runTeachingSkillFn?: typeof runTeachingSkill;
  // YUK-262 — swappable quiz-skill runner (the db test injects a fixture so the
  // {}-stub db is never touched). Defaults to the real runQuizSkill module.
  runQuizSkillFn?: typeof runQuizSkill;
  // YUK-275 — free-text 求卷 routing seams (the unit test injects fixtures so the
  // {}-stub db is never touched). detectQuizIntentFn is the零-LLM 粗筛; resolveQuizIntentFn
  // is the one-LLM 参数解析. Default to the real quiz-intent module.
  detectQuizIntentFn?: typeof detectQuizIntent;
  resolveQuizIntentFn?: typeof resolveQuizIntent;
  // PR #305 review comment #1 — swappable for unit tests (stub tx has no .select).
  materializeAskCheckFn?: typeof materializeAskCheckQuestion;
  // YUK-284 (C2) — swappable Copilot skill resolver. Defaults to resolveCopilotSkills
  // (reads <cwd>/src/subjects/_shared/skills/copilot/SKILL.md). Unit tests inject
  // () => ['copilot'] (命中) or () => undefined (降级) so they don't depend on disk.
  resolveCopilotSkillsFn?: typeof resolveCopilotSkills;
  now?: () => Date;
}

// P5.4-L2 / YUK-174 (Facet A, §3.3) — Copilot proposes ONLY knowledge_edge
// (COPILOT_TOOLS), so its digest scope is edge cells. Build the edge-scoped cell
// list, order reason-bearing cells FIRST, then truncate the SERIALIZED field to
// PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars at read time (the ContextBudgetTracker
// does NOT account initial-input chars — codex#3): drop whole cells from the
// least-actionable tail until the serialized JSON fits, so the field stays
// structured and bounded regardless of the tracker. Cold start (no edge cells) → [].
function scopeCopilotProposalFeedback(
  digest: ProposalFeedbackCell[],
): Array<
  Pick<
    ProposalFeedbackCell,
    'kind' | 'relation' | 'acceptance_rate' | 'top_dismiss_reasons' | 'top_rubric_gates'
  >
> {
  const edgeCells = digest
    .filter((cell) => cell.kind === 'knowledge_edge')
    .map((cell) => ({
      kind: cell.kind,
      relation: cell.relation,
      acceptance_rate: cell.acceptance_rate,
      top_dismiss_reasons: cell.top_dismiss_reasons,
      top_rubric_gates: cell.top_rubric_gates,
    }));
  // Copilot learns most from cells that carry an actual failure mode (net-negative
  // cells with dismiss reasons / rubric gates). The digest is sorted acceptance_rate
  // DESC, so a naive tail-drop would discard exactly those low-acceptance cells —
  // order reason-bearing cells FIRST so whole-digest truncation keeps them; reason-less
  // (typically high-acceptance) cells are dropped first. Stable within each group.
  const hasReasonContent = (c: (typeof edgeCells)[number]) =>
    c.top_dismiss_reasons.length > 0 || c.top_rubric_gates.length > 0;
  const ordered = [
    ...edgeCells.filter(hasReasonContent),
    ...edgeCells.filter((c) => !hasReasonContent(c)),
  ];
  // Truncate the SERIALIZED field to the whole-digest cap `maxSerializedChars` (NOT
  // `maxChars`, which is the per-string reason cap; a single populated cell exceeds
  // maxChars, so reusing it would collapse the feed to []). Drop the least-actionable
  // tail until it fits.
  const scoped = [...ordered];
  while (
    scoped.length > 0 &&
    JSON.stringify(scoped).length > PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars
  ) {
    scoped.pop();
  }
  return scoped;
}

// YUK-267 (C2) — the minimal history shape carried in the run input. ONLY role +
// text (the persisted ask原文 / reply正文); everything else from the turn row is
// EXPLICITLY dropped (防循环 ①/⑤).
export interface CopilotHistoryTurn {
  role: 'user' | 'ai';
  text: string;
}

// YUK-267 (C2) — assemble the bounded, history-only conversation_history from the
// session-scoped turn reader. 防循环 invariants enforced here:
//   ① each entry is {role, text} ONLY — NO skill_turn / skill_context / session_id
//      / reply_event_id / event_id / at, and certainly NO prior-run assembly
//      artifact (conversation_history / proposal_feedback / ambient_context). The
//      reader only exposes role+text (turns.ts), so this map is the structural
//      guarantee (防循环 ⑤ test feeds a polluted row and asserts {role,text} only).
//   ④ DOUBLE truncation — per-turn char cap, then whole-array char cap dropping the
//      OLDEST turns first until the serialized array fits (recency matters most).
// `turns` arrive oldest→newest (the reader reverses to chronological). We keep the
// newest maxTurns, per-turn truncate, then oldest-first whole-array truncate.
function assembleConversationHistory(
  turns: CopilotTurn[],
  budget: typeof COPILOT_HISTORY_BUDGET,
): CopilotHistoryTurn[] {
  // Keep the newest `maxTurns` (turns are oldest→newest, so tail-slice).
  const recent = turns.slice(-budget.maxTurns);
  // 防循环 ① — strip to {role, text} ONLY, then per-turn truncate (防循环 ④).
  const mapped: CopilotHistoryTurn[] = recent.map((t) => ({
    role: t.role,
    text: t.text.length > budget.perTurnChars ? t.text.slice(0, budget.perTurnChars) : t.text,
  }));
  // 防循环 ④ — whole-array cap: drop OLDEST (front) until the serialized array fits.
  while (mapped.length > 0 && JSON.stringify(mapped).length > budget.totalChars) {
    mapped.shift();
  }
  return mapped;
}

function selectSurface(triggeredBy: CopilotChatTriggerKind): DomainToolSurface {
  return triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot';
}

function selectActorRef(triggeredBy: CopilotChatTriggerKind): string {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

// YUK-266 (C1) — streaming options threaded through the shared chat impl. When
// present, the free-form path streams text deltas via `onDelta` (through
// streamAgentTaskFn) and the skill path pushes ONE delta (the full deterministic
// reply) so the transport stays uniform. `signal` is the request AbortSignal for
// client-disconnect teardown. Absent → the unchanged non-streaming behaviour.
interface CopilotStreamOptions {
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

async function runCopilotChatImpl(
  db: Db,
  req: CopilotChatRequestT,
  deps: CopilotChatDeps,
  streaming: CopilotStreamOptions | undefined,
): Promise<CopilotChatResult> {
  const now = deps.now?.() ?? new Date();
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const streamRun = deps.streamAgentTaskFn ?? streamTaskCollecting;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const buildTavily = deps.buildTavilyMcpServerFn ?? buildTavilyMcpServer;
  const write = deps.writeEventFn ?? writeEvent;
  const loadFeedback =
    deps.loadProposalFeedbackFn ??
    ((db: Db) => getProposalFeedbackDigest(db, PROPOSAL_FEEDBACK_BUDGET));
  const loadHistory = deps.loadHistoryFn ?? getRecentCopilotTurns;
  const findOrCreateConversation =
    deps.findOrCreateConversationFn ?? Conversation.findOrCreateCopilotConversation;
  const runTeachingSkillFn = deps.runTeachingSkillFn ?? runTeachingSkill;
  // YUK-284 (C3) — runSolveSkillFn default removed: chat.ts no longer dispatches solve.
  const runQuizSkillFn = deps.runQuizSkillFn ?? runQuizSkill;
  // YUK-275 — free-text 求卷 routing seams.
  const detectQuizIntentFn = deps.detectQuizIntentFn ?? detectQuizIntent;
  const resolveQuizIntentFn = deps.resolveQuizIntentFn ?? resolveQuizIntent;
  const materializeAskCheck = deps.materializeAskCheckFn ?? materializeAskCheckQuestion;
  // YUK-284 (C2) — resolve the Copilot skill whitelist ONCE (one existsSync), reused
  // by both the streaming and non-streaming free-form ctx below. undefined when the
  // shared SKILL.md is absent → free-form ctx omits skills (spread-when-present) →
  // byte-for-byte the pre-C2 ctx shape. The behavior-pack paths never touch this.
  const resolveSkills = deps.resolveCopilotSkillsFn ?? resolveCopilotSkills;
  const copilotSkills = resolveSkills();

  const surface = selectSurface(req.triggered_by);
  const actorRef = selectActorRef(req.triggered_by);
  const taskRunId = `copilot_task_${createId()}`;
  let causedByEventId: string | undefined;
  let userAskEventId: string | undefined;

  // AF S3a / YUK-203 U3 — resolve the durable conversation envelope FIRST so the
  // ask/chip + reply events all carry the same session_id. The events table's
  // session_id column = the event's conversation session and is shared by BOTH
  // teaching and copilot (codex #3356884490/#3356974269 裁决): it is NOT teaching-
  // exclusive. payload.session_id is kept as a redundant portable copy. Writing
  // the column on the user/chip events (not just the reply) lets the idle clock
  // (promote_conversation_idle, which joins event.session_id = ls.id AND
  // actor_kind='user') see Copilot user activity instead of idling on started_at.
  // Both chat + chip turns belong to the same Copilot conversation.
  const { sessionId } = await findOrCreateConversation(db, { now });

  // YUK-267 (C2) — read conversation_history BEFORE writing the current ask event
  // so the just-asked message is STRUCTURALLY excluded from its own history (no
  // double-count). Free-form path only — skill turns short-circuit below and never
  // build the run input. Additive-input red line: a read failure degrades to [] and
  // never crashes the chat (same pattern as the feedback digest). 防循环 ① is the
  // {role,text}-only map in assembleConversationHistory.
  let conversationHistory: CopilotHistoryTurn[] = [];
  if (!req.skill_context) {
    try {
      const rawTurns = await loadHistory(db, { limit: COPILOT_HISTORY_BUDGET.maxTurns, now });
      conversationHistory = assembleConversationHistory(rawTurns, COPILOT_HISTORY_BUDGET);
    } catch (err) {
      conversationHistory = [];
      console.error('[runCopilotChat] loadHistory failed; degrading to []', {
        task_run_id: taskRunId,
        surface,
        err,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // T-D3/C event-write contract.
  //
  //   chat path : writeEvent(experimental:copilot_user_ask)
  //   chip path : SKIP user ask event. The chip itself is the user signal,
  //               but it's a UI-side click — not a typed ask. We still
  //               write a lightweight `experimental:copilot_chip_trigger`
  //               so analytics + cause-chain links work.
  // ──────────────────────────────────────────────────────────────────────
  if (req.triggered_by === 'chat') {
    userAskEventId = `copilot_user_ask_${createId()}`;
    await write(db, {
      id: userAskEventId,
      // codex #3356884490 — write the session_id column on the user ask (not just
      // payload) so the idle clock sees this as a user turn for THIS session.
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'user:self',
      action: USER_ASK_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: userAskEventId,
      outcome: null,
      payload: {
        surface: 'copilot',
        user_message: req.user_message,
        // AF S3a — redundant portable copy of the conversation envelope id.
        session_id: sessionId,
      },
      created_at: now,
    });
    causedByEventId = userAskEventId;
  } else {
    const chipEventId = `copilot_chip_${createId()}`;
    await write(db, {
      id: chipEventId,
      // codex #3356884490 — write the session_id column on the chip trigger too,
      // so chip-driven user activity is attributed to THIS conversation session
      // (same idle-clock + replay reasons as the ask path above).
      session_id: sessionId,
      actor_kind: 'system',
      actor_ref: 'ui:copilot_chip',
      action: CHIP_TRIGGER_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: chipEventId,
      outcome: null,
      payload: {
        surface: 'copilot',
        chip_kind: req.chip_kind ?? null,
        user_message: req.user_message,
        // AF S3a — redundant portable copy of the conversation envelope id.
        session_id: sessionId,
      },
      created_at: now,
    });
    causedByEventId = chipEventId;
  }

  // §D5 / YUK-275 — the SINGLE quiz reply out-port, shared by the skill_context path
  // (chip-seeded skill:'quiz') and the free-text intercept below. Runs runQuizSkillFn
  // (pure SERVICE orchestration, NO LLM run), writes ONE copilot_reply event reusing the
  // synthetic `taskRunId` (no model run on the quiz path → the user_ask→reply evidence
  // chain stays uniform with teaching/solve; the parse LLM's task_run_id is evidence-only
  // and never reaches the reply chain — 防循环 red line), emits ONE streaming delta, and
  // returns the terminal CopilotChatResult. `skillContextForReplay` is persisted so replay
  // can restore the skill card (Dock chip renderer). difficultyMin/unit/kind are the
  // free-text 扩参 (null for the chip path → byte-for-byte the pre-YUK-275 behaviour).
  async function emitQuizReply(args: {
    knowledgeId: string;
    count?: number | null;
    difficultyMin?: number | null;
    unit?: '题' | '篇' | null;
    kind?: string | null;
    skillContextForReplay: CopilotSkillContextT;
  }): Promise<CopilotChatResult> {
    const replyEventId = `copilot_reply_${createId()}`;
    const skillResult: QuizSkillResult = await runQuizSkillFn({
      db,
      sessionId,
      knowledgeId: args.knowledgeId,
      userMessage: req.user_message,
      ...(args.count != null ? { count: args.count } : {}),
      ...(args.difficultyMin != null ? { difficultyMin: args.difficultyMin } : {}),
      ...(args.unit != null ? { unit: args.unit } : {}),
      ...(args.kind != null ? { kind: args.kind } : {}),
    });
    const replyMd = skillResult.text_md;
    // Synthetic run id (no LLM run on the quiz execution path — see block comment above).
    const realTaskRunId = taskRunId;

    const replyAt = new Date(now.getTime() + 1);
    await write(db, {
      id: replyEventId,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: REPLY_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: replyEventId,
      outcome: null,
      payload: {
        surface: 'copilot',
        session_id: sessionId,
        reply_md: replyMd,
        task_run_id: realTaskRunId,
        in_reply_to_event_id: causedByEventId ?? null,
        // Persist skill_context so replay can restore the skill card (Dock chip renderer
        // + replayToMessages use it). For the free-text path this is a synthesized
        // {skill:'quiz', ref:{kind:'knowledge', id}} so the seeded + free-text paths are
        // replay-identical.
        skill_context: args.skillContextForReplay,
      },
      caused_by_event_id: causedByEventId ?? null,
      task_run_id: realTaskRunId,
      created_at: replyAt,
    });

    // YUK-266 (C1) — quiz replies are deterministic / single-shot (no token loop), so
    // when streaming we emit ONE delta carrying the full reply (aligns with the既有 skill
    // path at the shared :701 behaviour), then return the terminal `reply` event.
    if (streaming) streaming.onDelta(replyMd);

    return {
      task_run_id: realTaskRunId,
      reply: replyMd,
      // Force surface 'copilot' to match the persisted reply payload (CodeRabbit F3).
      surface: 'copilot',
      triggered_by: req.triggered_by,
      session_id: sessionId,
      reply_event_id: replyEventId,
      ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
    };
  }

  // §D5 / YUK-275 — emit a deterministic 追问 reply (no LLM) when the free-text 求卷 was
  // a 求卷 intent but could not be resolved into a knowledge node (missing_knowledge /
  // parse_failed). 绝不 text-spray a quiz, 绝不 回落 free-form. Reuses the same reply-event
  // write + streaming-delta contract as emitQuizReply (no skill_context — there is no
  // skill card to replay).
  async function emitQuizClarifyReply(replyMd: string): Promise<CopilotChatResult> {
    const replyEventId = `copilot_reply_${createId()}`;
    const realTaskRunId = taskRunId;
    const replyAt = new Date(now.getTime() + 1);
    await write(db, {
      id: replyEventId,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: REPLY_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: replyEventId,
      outcome: null,
      payload: {
        surface: 'copilot',
        session_id: sessionId,
        reply_md: replyMd,
        task_run_id: realTaskRunId,
        in_reply_to_event_id: causedByEventId ?? null,
      },
      caused_by_event_id: causedByEventId ?? null,
      task_run_id: realTaskRunId,
      created_at: replyAt,
    });
    if (streaming) streaming.onDelta(replyMd);
    return {
      task_run_id: realTaskRunId,
      reply: replyMd,
      surface: 'copilot',
      triggered_by: req.triggered_by,
      session_id: sessionId,
      reply_event_id: replyEventId,
      ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
    };
  }

  // YUK-284 (C1) — teaching behavior pack as a self-contained handler that RETURNS
  // its own terminal CopilotChatResult (no block-tail shared return). Logic moved
  // verbatim from the former `if (skill_context.skill==='teaching')` branch: the
  // reply-event write + ask_check materialization stay inside ONE db.transaction
  // (PR #305 #1 atomicity), turn_kind + skill_turn + skill_context persistence are
  // byte-for-byte unchanged. The surface stays 'copilot' (R5: skill ≠ surface — the
  // budget tracker / mcp / tool allowlist below are NOT constructed on this path),
  // and the TeachingTurnTask call inside the pack is a service call (OQ5).
  // skillContext is the narrowed (non-undefined) req.skill_context passed by the
  // dispatch table under `if (req.skill_context)`.
  async function runTeachingBehaviorPack(
    skillContext: CopilotSkillContextT,
  ): Promise<CopilotChatResult> {
    // Pre-generate the reply event id so ask_check materialization (which needs
    // it as source_ref) and the reply event write can share the same tx (PR #305
    // review comment #1: prevents dangling question row on reply-write failure).
    const replyEventId = `copilot_reply_${createId()}`;
    const skillResult: TeachingSkillResult = await runTeachingSkillFn({
      db,
      sessionId,
      learningItemId: skillContext.ref.id,
      userMessage: req.user_message,
    });
    const replyMd = skillResult.text_md;
    // PR #305 review comment #3: use the real task_run_id from the skill runner.
    const realTaskRunId = skillResult.task_run_id;
    // Carry the teaching turn kind onto the copilot_reply payload so the
    // accept-chip resolver can anchor a corrective chip on THIS event (R1 pairing,
    // load-bearing — §4.2). Free-form replies and solve hints carry no turn_kind.
    const turnKind: 'explain' | 'ask_check' | 'end' = skillResult.kind;

    // PR #305 review comment #1 (atomicity): materialize the ask_check question
    // INSIDE the reply-event write transaction — both or neither persist.
    const replyAt = new Date(now.getTime() + 1);
    const materializedQuestion = await db.transaction(async (tx: Tx) => {
      let mat: MaterializedAskCheckQuestion | undefined;
      if (skillResult.pendingQuestion) {
        mat = await materializeAskCheck(tx, {
          ...skillResult.pendingQuestion,
          sourceRef: replyEventId,
        });
      }
      await write(tx, {
        id: replyEventId,
        session_id: sessionId,
        actor_kind: 'agent',
        actor_ref: actorRef,
        action: REPLY_EVENT_ACTION,
        subject_kind: 'query',
        subject_id: replyEventId,
        outcome: null,
        payload: {
          surface: 'copilot',
          session_id: sessionId,
          reply_md: replyMd,
          // PR #305 review comment #3: real task_run_id from TeachingTurnTask.
          task_run_id: realTaskRunId,
          in_reply_to_event_id: causedByEventId ?? null,
          // AF S4 — corrective-chip anchor key (only for teaching turns).
          turn_kind: turnKind,
          // PR #305 review comment #2: persist skill_turn so replay can surface
          // it without re-running the LLM (ask_check carries structured_question).
          ...(mat
            ? {
                skill_turn: {
                  kind: skillResult.kind,
                  suggested_next: skillResult.suggested_next,
                  structured_question: mat,
                },
              }
            : {
                skill_turn: {
                  kind: skillResult.kind,
                  suggested_next: skillResult.suggested_next,
                },
              }),
          // PR round-2 (CR 3360614441): persist skill_context so replay can
          // restore the skill card (Dock chip renderer + replayToMessages use it).
          skill_context: skillContext,
        },
        caused_by_event_id: causedByEventId ?? null,
        task_run_id: realTaskRunId,
        created_at: replyAt,
      });
      return mat;
    });

    const skillTurn: CopilotSkillTurn = {
      kind: skillResult.kind,
      suggested_next: skillResult.suggested_next,
      ...(materializedQuestion ? { structured_question: materializedQuestion } : {}),
    };

    // YUK-266 (C1) — skill turns are deterministic / single-shot (no token loop),
    // so when streaming we emit ONE delta carrying the full reply, then the caller
    // emits the terminal `reply` event. This keeps one transport code path across
    // free-form and skill turns.
    if (streaming) streaming.onDelta(replyMd);

    return {
      // PR #305 review comment #3: expose the real task_run_id (not the pre-generated
      // placeholder) so cost-tracing links the API response to the actual LLM run.
      task_run_id: realTaskRunId,
      reply: replyMd,
      // PR #342 bot-review (CodeRabbit F3): force the skill-turn surface to
      // 'copilot' so the API response matches the persisted reply-event payload
      // (which hard-codes surface:'copilot'). The `surface` variable is
      // triggered_by-derived and becomes 'copilot_user_suggested_mistake_action'
      // on a chip turn — returning it here would fork the API/replay-audit
      // contract for any chip+skill_context turn.
      surface: 'copilot',
      triggered_by: req.triggered_by,
      session_id: sessionId,
      reply_event_id: replyEventId,
      ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
      skill_turn: skillTurn,
    };
  }

  // YUK-284 (C3) — the former runSolveBehaviorPack handler is removed. solve is no
  // longer a chat-routed behavior pack: it was a dead入口 (no UI seed ever produced
  // skill_context:{skill:'solve'}). runSolveSkill remains an independent service
  // (src/server/copilot/skills/solve-skill.ts) for a future题目页 inline入口; chat.ts
  // no longer dispatches to it. A persisted-old / anomalous skill:'solve' falls
  // through to the free-form CopilotTask path (see the dispatch降级 below).

  // §D1/§D2/§D5 / YUK-275 — free-text 求卷 intercept. Only typed chat turns WITHOUT a
  // skill_context are eligible (the chip path carries skill_context:{skill:'quiz'} and is
  // handled by the既有 skill branch below — the `!req.skill_context` guard避让 it, no
  // double-routing). 粗筛 (零 LLM) gates the parse tax; on a miss we fall through to the
  // free-form CopilotTask path byte-for-byte. On a hit, ONE small parse call decides the
  // four-state route (resolved → quiz; not_quiz → 回落 free-form; missing_knowledge /
  // parse_failed → deterministic 追问).
  if (req.triggered_by === 'chat' && !req.skill_context && detectQuizIntentFn(req.user_message)) {
    const resolved = await resolveQuizIntentFn({
      db,
      userMessage: req.user_message,
      // runTask is the structured text runner. resolveQuizIntent's TaskTextRunFn has a
      // `ctx: unknown` param (DI-friendly), so adapt to runTask's RunTaskCtx — the ctx we
      // pass ({db}) is a valid RunTaskCtx. RunTaskResult is a superset of TaskTextResult
      // ({text, task_run_id?, cost_usd?}), so the return type is compatible.
      runTaskFn: (kind, input, ctx) => runTask(kind, input, ctx as Parameters<typeof runTask>[2]),
      subjectProfile: undefined,
    });
    if (resolved.status === 'resolved') {
      return emitQuizReply({
        knowledgeId: resolved.knowledgeId,
        count: resolved.count,
        difficultyMin: resolved.difficultyMin,
        unit: resolved.unit,
        kind: resolved.kind,
        skillContextForReplay: {
          skill: 'quiz',
          ref: { kind: 'knowledge', id: resolved.knowledgeId },
        },
      });
    }
    if (resolved.status === 'missing_knowledge') {
      return emitQuizClarifyReply(QUIZ_INTENT_MISSING_KNOWLEDGE_REPLY);
    }
    if (resolved.status === 'parse_failed') {
      return emitQuizClarifyReply(QUIZ_INTENT_PARSE_FAILED_REPLY);
    }
    // status:'not_quiz' — 粗筛 误伤被解析兜回; do NOT return, fall through to the既有
    // free-form CopilotTask path (the深度兜底 so normal conversation is never hijacked).
  }

  // AF S4 / YUK-203 U6 (§4.4) — skill_context routing. A skill_context turn runs a
  // teaching behavior pack at the SERVICE layer instead of the free-form CopilotTask
  // tool loop. The surface stays 'copilot' (R5: skill ≠ surface — the budget tracker
  // / mcp / tool allowlist below are NOT constructed on the teaching path), and the
  // TeachingTurnTask call inside the pack is a service call, so it draws down NO tool
  // budget (OQ5). The turn lives entirely on this single Copilot session.
  //
  // YUK-284 (C3) — the dispatch is三层 ordered (each branch self-returns or falls
  // through; there is NO block-tail shared return reading half-assigned locals):
  //   1. quiz → service-action early-intercept (emitQuizReply); NOT a behavior pack.
  //   2. teaching → the only真 behavior pack; self-returning early-return.
  //   3. solve / 未知 kind → 显式降级 warn + fall through to the free-form path.
  // YUK-284 (C3) — quiz is a SERVICE ACTION, not a behavior pack: a chip-seeded
  // skill_context.skill==='quiz' is intercepted HERE (before any behavior-pack
  // dispatch) and shares the emitQuizReply service out-port with the free-text
  // entry (GZ-1 正名). The wire shape stays skill_context:{skill:'quiz'} (Dock seed
  // + replay persistence unchanged → 零破坏), only the server-side classification
  // moves from「behavior-pack 查表分支」to「early service-action intercept」.
  // §D5: reply-event write + synthetic-run-id reuse + skill_context persistence are
  // shared with the free-text path via emitQuizReply (DRY); the chip path passes the
  // 既有 skill_context verbatim for replay and no free-text 扩参 (difficultyMin/unit/
  // kind null → byte-for-byte the pre-YUK-275 behaviour).
  if (req.skill_context?.skill === 'quiz') {
    return emitQuizReply({
      knowledgeId: req.skill_context.ref.id,
      skillContextForReplay: req.skill_context, // wire 不变，replay 零破坏
    });
  }

  // YUK-284 (C3) — teaching is the only真 behavior pack left. Early-return its own
  // terminal result (the pack handler self-returns; there is NO block-tail shared
  // return). solve was extracted to an independent service (runSolveSkill, no chat
  // routing) and the chip/free-text quiz are handled above, so any other
  // skill_context.skill value (solve from a chip that no longer exists, or a
  // persisted-old-solve replay) does NOT enter here — it falls through to the
  // free-form CopilotTask path below.
  if (req.skill_context?.skill === 'teaching') {
    return runTeachingBehaviorPack(req.skill_context);
  }

  // YUK-284 (C3) — solve / 未知 kind 显式降级: no behavior-pack handler, so log and
  // fall through to the free-form CopilotTask path (R5 单用户自托管下宁可降级不崩;
  // 旧 solve 请求/replay 不会让会话崩溃). Reaching here means skill_context is present
  // but is neither quiz nor teaching. 控制流红线: this MUST continue down to the
  // free-form path (NOT execute a block-tail shared return reading未赋值局部) — that
  // is why C1 made each pack handler self-return and removed the shared block-tail
  // return entirely.
  if (req.skill_context) {
    console.warn('[copilot] no behavior pack handler; falling through to free-form', {
      skill: req.skill_context.skill,
      task_run_id: taskRunId,
    });
  }

  // P5.1 / YUK-143 — per-message context-budget throttle. One tracker lives for
  // the duration of THIS user message's agent turn (created here, discarded
  // when runCopilotChat returns), so the bound sums across all the message's
  // tool calls (spec §3.4 "tracked"). It mirrors the per-run proposalWrites
  // accumulator Dreaming/Coach hold. Both chat + chip surfaces run the same
  // user-facing CopilotTask, so both get the Copilot budget.
  const budgetTracker = new ContextBudgetTracker(resolveContextBudget(surface));

  const mcpServer = buildMcpServer({
    ctx: {
      db,
      taskRunId,
      callerActor: { kind: 'agent', ref: actorRef },
      causedByEventId,
    },
    serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
    toolNames: resolveDomainToolNames(surface),
    taskKind: 'CopilotTask',
    // Tool-call ceiling: soft-stop once maxToolCalls is reached (same mechanism
    // as Dreaming/Coach's proposal cap; the model reads the string + stops).
    beforeExecute: (tool) => budgetTracker.beforeExecute(tool),
    // Limit cap + accounting + truncation note: cap the requested limit down to
    // remaining nodes+edges / event-rows budget before execute, surface what
    // was capped to the agent. Graceful degradation, never a hard reject.
    interceptInput: (tool, args) => {
      const { args: capped, truncation, softStop } = budgetTracker.capInput(tool.name, args);
      // FIX 1 (YUK-143): when the dimension is exhausted, propagate the
      // soft-stop string so the bridge skips execute (graceful stop, never a
      // limit:0 → Zod throw). Otherwise pass the (possibly capped) args + note.
      return { args: capped, truncationNote: truncation, softStop };
    },
  });

  // P5.4-L2 / YUK-174 (Facet A, §3.3) — read the feedback digest ONCE for this
  // message and edge-scope + char-bound it before building the run input. A
  // single bounded read (not per-tool-call), pre-truncated to maxChars so the
  // per-message prompt cannot bloat regardless of the ContextBudgetTracker (which
  // gates only the tool-call loop, codex#3). Cold start → [].
  //
  // The digest is an ADDITIVE input (ND-5): a read failure must NOT crash the
  // chat. Degrade to [] (same as cold start) and continue; log so the silent
  // empty is traceable (codex C4).
  let proposalFeedback: ReturnType<typeof scopeCopilotProposalFeedback> = [];
  try {
    proposalFeedback = scopeCopilotProposalFeedback(await loadFeedback(db));
  } catch (err) {
    proposalFeedback = [];
    console.error('[runCopilotChat] loadProposalFeedback failed; degrading to []', {
      task_run_id: taskRunId,
      surface,
      err,
    });
  }

  // YUK-198 — optionally fold in the remote Tavily MCP (web grounding) for the
  // Copilot surface. Env-gated: when TAVILY_API_KEY is unset, buildTavily()
  // returns null and both the mcpServers map and allowedTools are identical to
  // the pre-YUK-198 behaviour (no tavily server, no tavily tools). Only Copilot
  // gets this — Dreaming / Coach / other cron handlers are untouched (they must
  // not reach the network).
  const tavilyCfg = buildTavily();
  const mcpServers: Record<string, SdkMcpServer | McpHttpServerConfig> = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer,
    ...(tavilyCfg ? { [TAVILY_MCP_SERVER_NAME]: tavilyCfg } : {}),
  };
  const allowedTools = [
    ...resolveMcpAllowedTools(surface),
    ...(tavilyCfg ? TAVILY_MCP_ALLOWED_TOOLS : []),
  ];

  const runInput = {
    surface,
    triggered_by: req.triggered_by,
    user_message: req.user_message,
    ...(req.chip_kind ? { chip_kind: req.chip_kind } : {}),
    // Edge-scoped, char-bounded reason digest. Serialized verbatim into the
    // prompt by promptFromInput (runner.ts JSON.stringify) — no new plumbing.
    proposal_feedback: proposalFeedback,
    // YUK-267 (C2) — bounded, history-only conversation context (防循环 ①/④/⑤).
    // [{role,text}], oldest→newest, double-truncated. The current ask is excluded
    // (read before the ask write). Serialized verbatim by promptFromInput.
    conversation_history: conversationHistory,
    // YUK-267 (C2) — ambient context for THIS message only (防循环 ②). Present only
    // when the request carried it; NEVER written to any turn payload, so it is not
    // replayed. Forwarded verbatim.
    ...(req.ambient_context ? { ambient_context: req.ambient_context } : {}),
  };

  // YUK-266 (C1) — the free-form path runs the CopilotTask token loop. When
  // streaming, route through streamAgentTaskFn (streamTaskCollecting) so text
  // deltas reach the client as they are produced, then collect the full text +
  // real task_run_id; the reply-event persistence below is byte-identical to the
  // non-stream path (S3a contract). When NOT streaming, the unchanged
  // runAgentTask path returns one final result. The streaming runner degrades
  // gracefully (resolves a partial result on SDK error) rather than throwing.
  let replyText: string;
  let replyRunId: string;
  let streamError: string | undefined;
  if (streaming) {
    const streamResult = await streamRun(
      'CopilotTask',
      runInput,
      {
        db,
        mcpServers,
        allowedTools,
        signal: streaming.signal,
        // YUK-284 (C2) — spread-when-present: when the copilot SKILL.md is absent
        // (copilotSkills === undefined) the ctx omits `skills` entirely, byte-for-byte
        // the pre-C2 shape (runner ctx.skills ?? [] unchanged → no regression).
        ...(copilotSkills ? { skills: copilotSkills } : {}),
      },
      streaming.onDelta,
    );
    replyText = streamResult.text;
    replyRunId = streamResult.task_run_id;
    if (streamResult.partial) streamError = streamResult.error;
  } else {
    const result = await run('CopilotTask', runInput, {
      db,
      mcpServers,
      allowedTools,
      // YUK-284 (C2) — see streaming branch above (spread-when-present).
      ...(copilotSkills ? { skills: copilotSkills } : {}),
    });
    replyText = result.text;
    replyRunId = result.task_run_id;
  }

  // AF S3a / YUK-203 U3 — persist the reply turn so the drawer can replay-last-N.
  // The reply chains to the user ask/chip event (causedByEventId) so the turn
  // pair is reconstructable. actor = the running agent (matches the chat run's
  // actorRef). Payload free-form per ExperimentalEvent (zero schema).
  //
  // created_at is stamped strictly AFTER the ask (now + 1ms): the whole turn
  // shares the single captured `now`, so without the offset the ask and reply
  // tie on created_at and the turns reader's (created_at, id) sort can place the
  // reply before its own ask. The reply genuinely follows the ask in time, so a
  // 1ms bump is faithful and keeps the pair ordered for replay.
  const replyAt = new Date(now.getTime() + 1);
  const replyEventId = `copilot_reply_${createId()}`;
  await write(db, {
    id: replyEventId,
    // session_id column = this event's conversation session (shared by teaching +
    // copilot; codex #3356974269 裁决 — keep the column write, it is not teaching-
    // exclusive). payload.session_id below is the redundant portable copy.
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: actorRef,
    action: REPLY_EVENT_ACTION,
    subject_kind: 'query',
    subject_id: replyEventId,
    outcome: null,
    payload: {
      surface: 'copilot',
      session_id: sessionId,
      reply_md: replyText,
      task_run_id: replyRunId,
      in_reply_to_event_id: causedByEventId ?? null,
    },
    caused_by_event_id: causedByEventId ?? null,
    task_run_id: replyRunId,
    created_at: replyAt,
  });

  return {
    task_run_id: replyRunId,
    reply: replyText,
    surface,
    triggered_by: req.triggered_by,
    session_id: sessionId,
    reply_event_id: replyEventId,
    ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
    // YUK-266 (C1) — surface the partial-degrade note only when the stream errored
    // mid-flight (additive optional; absent on the non-stream + clean-stream paths).
    ...(streamError ? { error: streamError } : {}),
  };
}

// Non-streaming entrypoint — unchanged public contract. Existing unit tests + any
// non-stream caller keep working byte-for-byte; the shared impl runs with no
// streaming options so the free-form path uses runAgentTask and emits no deltas.
export async function runCopilotChat(
  db: Db,
  req: CopilotChatRequestT,
  deps: CopilotChatDeps = {},
): Promise<CopilotChatResult> {
  return runCopilotChatImpl(db, req, deps, undefined);
}

// YUK-266 (C1) — streaming entrypoint. Identical turn-persistence contract to
// runCopilotChat (the SAME single experimental:copilot_reply event is written with
// the full text + real task_run_id), but text deltas are streamed to `onDelta` as
// they are produced and the resolved CopilotChatResult is the terminal payload the
// route emits as the `reply` SSE event. Streaming failure degrades gracefully:
// whatever text was collected is still persisted + returned (with an `error` note),
// so a turn is never lost. `signal` (req.signal) tears the SDK run down on client
// disconnect.
export async function runCopilotChatStreaming(
  db: Db,
  req: CopilotChatRequestT,
  onDelta: (text: string) => void,
  deps: CopilotChatDeps = {},
  signal?: AbortSignal,
): Promise<CopilotChatResult> {
  return runCopilotChatImpl(db, req, deps, { onDelta, signal });
}
