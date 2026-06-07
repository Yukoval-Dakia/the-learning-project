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
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolSurface,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { PROPOSAL_FEEDBACK_BUDGET, resolveContextBudget } from '@/server/ai/tools/budgets';
import { ContextBudgetTracker } from '@/server/ai/tools/context-throttle';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
// AF S4 / YUK-203 U6 — Copilot skills (behavior packs). A skill_context turn
// routes to these at the service layer instead of the free-form CopilotTask loop.
import { type QuizSkillResult, runQuizSkill } from '@/server/copilot/skills/quiz-skill';
import { type SolveSkillResult, runSolveSkill } from '@/server/copilot/skills/solve-skill';
import { type TeachingSkillResult, runTeachingSkill } from '@/server/copilot/skills/teaching-skill';
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
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export const COPILOT_CHAT_TRIGGER_KINDS = ['chat', 'chip'] as const;
export type CopilotChatTriggerKind = (typeof COPILOT_CHAT_TRIGGER_KINDS)[number];

// AF S4 / YUK-203 U6 — the surface-merge skill selector. A `skill_context`
// turn routes runCopilotChat to a teaching/solve behavior pack (a prompt/context
// pack, NEVER a different tool surface — R5: skill ≠ surface). The skills compose
// TeachingTurnTask at the SERVICE layer; they do not add tools to COPILOT_TOOLS.
//
// FORWARD-COMPAT NOTE: `skill_context` is the U6-temporary seed of AF S2b's
// `CurrentUserContext.active_ref` (agent-framework-design §1.4). When S2b lands
// the full `active_ref` envelope, this field is subsumed by it — both the `skill`
// discriminator and the `ref` shape are deliberately minimal so the migration is
// additive. The `ref` shape `{ kind, id }` mirrors `leave_agent_note`'s ref
// vocabulary (AF §4 `refs: Array<{kind, id}>`) for consistency.
// YUK-262 — `quiz` added as the third skill (a behavior pack, NOT a tool surface —
// R5: skill ≠ surface). The quiz skill composes runSourcingSequence + a tool_quiz
// INSERT at the SERVICE layer; it adds NO tools to COPILOT_TOOLS.
export const COPILOT_SKILL_KINDS = ['teaching', 'solve', 'quiz'] as const;
export type CopilotSkillKind = (typeof COPILOT_SKILL_KINDS)[number];

export const CopilotSkillContext = z.object({
  skill: z.enum(COPILOT_SKILL_KINDS),
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
  },
) => Promise<RunTaskResult>;
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

export interface CopilotChatDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  // YUK-198 — defaults to buildTavilyMcpServer (reads TAVILY_API_KEY). Returns
  // null when unconfigured → Tavily is not registered and no extra allowedTools
  // are added (back-compat no-op).
  buildTavilyMcpServerFn?: BuildTavilyMcpServerFn;
  writeEventFn?: WriteEventFn;
  // P5.4-L2 / YUK-174 — defaults to getProposalFeedbackDigest. The unit test
  // injects [] so the {}-stub db is never queried (cold-start no-op).
  loadProposalFeedbackFn?: LoadProposalFeedbackFn;
  // AF S3a / YUK-203 U3 — defaults to Conversation.findOrCreateCopilotConversation.
  findOrCreateConversationFn?: FindOrCreateConversationFn;
  // AF S4 / YUK-203 U6 — swappable skill runners (unit tests inject fixtures so
  // the {}-stub db is never touched). Default to the real skill modules.
  runTeachingSkillFn?: typeof runTeachingSkill;
  runSolveSkillFn?: typeof runSolveSkill;
  // YUK-262 — swappable quiz-skill runner (the db test injects a fixture so the
  // {}-stub db is never touched). Defaults to the real runQuizSkill module.
  runQuizSkillFn?: typeof runQuizSkill;
  // PR #305 review comment #1 — swappable for unit tests (stub tx has no .select).
  materializeAskCheckFn?: typeof materializeAskCheckQuestion;
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

function selectSurface(triggeredBy: CopilotChatTriggerKind): DomainToolSurface {
  return triggeredBy === 'chip' ? 'copilot_user_suggested_mistake_action' : 'copilot';
}

function selectActorRef(triggeredBy: CopilotChatTriggerKind): string {
  return triggeredBy === 'chip' ? 'agent:copilot_chip' : 'agent:copilot';
}

export async function runCopilotChat(
  db: Db,
  req: CopilotChatRequestT,
  deps: CopilotChatDeps = {},
): Promise<CopilotChatResult> {
  const now = deps.now?.() ?? new Date();
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const buildTavily = deps.buildTavilyMcpServerFn ?? buildTavilyMcpServer;
  const write = deps.writeEventFn ?? writeEvent;
  const loadFeedback =
    deps.loadProposalFeedbackFn ??
    ((db: Db) => getProposalFeedbackDigest(db, PROPOSAL_FEEDBACK_BUDGET));
  const findOrCreateConversation =
    deps.findOrCreateConversationFn ?? Conversation.findOrCreateCopilotConversation;
  const runTeachingSkillFn = deps.runTeachingSkillFn ?? runTeachingSkill;
  const runSolveSkillFn = deps.runSolveSkillFn ?? runSolveSkill;
  const runQuizSkillFn = deps.runQuizSkillFn ?? runQuizSkill;
  const materializeAskCheck = deps.materializeAskCheckFn ?? materializeAskCheckQuestion;

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

  // AF S4 / YUK-203 U6 (§4.4) — skill routing. A skill_context turn runs a
  // teaching/solve behavior pack at the SERVICE layer instead of the free-form
  // CopilotTask tool loop. The surface stays 'copilot' (R5: skill ≠ surface — the
  // budget tracker / mcp / tool allowlist below are NOT constructed on this path),
  // and the TeachingTurnTask call inside the skill is a service call, so it draws
  // down NO tool budget (OQ5). The skill turn lives entirely on this single
  // Copilot session (Cross-统合 single-session).
  if (req.skill_context) {
    // Pre-generate the reply event id so ask_check materialization (which needs
    // it as source_ref) and the reply event write can share the same tx (PR #305
    // review comment #1: prevents dangling question row on reply-write failure).
    const replyEventId = `copilot_reply_${createId()}`;
    let replyMd: string;
    let realTaskRunId: string;
    // Carry the teaching turn kind onto the copilot_reply payload so the
    // accept-chip resolver can anchor a corrective chip on THIS event (R1 pairing,
    // load-bearing — §4.2). Free-form replies and solve hints carry no turn_kind.
    let turnKind: 'explain' | 'ask_check' | 'end' | undefined;
    let skillTurn: CopilotSkillTurn | undefined;
    let materializedQuestion: MaterializedAskCheckQuestion | undefined;

    if (req.skill_context.skill === 'teaching') {
      const skillResult: TeachingSkillResult = await runTeachingSkillFn({
        db,
        sessionId,
        learningItemId: req.skill_context.ref.id,
        userMessage: req.user_message,
      });
      replyMd = skillResult.text_md;
      // PR #305 review comment #3: use the real task_run_id from the skill runner.
      realTaskRunId = skillResult.task_run_id;
      turnKind = skillResult.kind;

      // PR #305 review comment #1 (atomicity): materialize the ask_check question
      // INSIDE the reply-event write transaction — both or neither persist.
      const replyAt = new Date(now.getTime() + 1);
      materializedQuestion = await db.transaction(async (tx: Tx) => {
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
            ...(turnKind ? { turn_kind: turnKind } : {}),
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
              : turnKind
                ? {
                    skill_turn: {
                      kind: skillResult.kind,
                      suggested_next: skillResult.suggested_next,
                    },
                  }
                : {}),
            // PR round-2 (CR 3360614441): persist skill_context so replay can
            // restore the skill card (Dock chip renderer + replayToMessages use it).
            skill_context: req.skill_context,
          },
          caused_by_event_id: causedByEventId ?? null,
          task_run_id: realTaskRunId,
          created_at: replyAt,
        });
        return mat;
      });

      skillTurn = {
        kind: skillResult.kind,
        suggested_next: skillResult.suggested_next,
        ...(materializedQuestion ? { structured_question: materializedQuestion } : {}),
      };
    } else if (req.skill_context.skill === 'solve') {
      // hintIndex 故意不传（恒为首问 hint）：U6 MVP 只做 hint-only solve skill，
      // buildSolveHintInput 的递进分支（hintIndex>0 合成追问）经此入口是死代码。
      // 接续上下文见 plan §11（cut-over 时机）：若要递进，需按 session 内既往
      // solve turn 计数派生 hintIndex（review LOW note，intentional-by-record）。
      const skillResult: SolveSkillResult = await runSolveSkillFn({
        db,
        questionId: req.skill_context.ref.id,
      });
      replyMd = skillResult.text_md;
      // PR #305 review comment #3: use the real task_run_id from the skill runner.
      realTaskRunId = skillResult.task_run_id;

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
          // PR #305 review comment #3: real task_run_id from TeachingTurnTask.
          task_run_id: realTaskRunId,
          in_reply_to_event_id: causedByEventId ?? null,
          // PR round-2 (CR 3360614441): persist skill_context so replay can
          // restore the skill card (Dock chip renderer + replayToMessages use it).
          skill_context: req.skill_context,
        },
        caused_by_event_id: causedByEventId ?? null,
        task_run_id: realTaskRunId,
        created_at: replyAt,
      });
    } else if (req.skill_context.skill === 'quiz') {
      // YUK-262 — quiz skill. Pure SERVICE orchestration: source the existing pool
      // → assemble + persist a tool_quiz artifact → reply with a /practice/<id>
      // link (or an explicit degradation notice; NEVER a text-sprayed quiz). There
      // is NO LLM run on this path (unlike teaching/solve, which call
      // TeachingTurnTask), so the skill mints no model task_run_id. We reuse the
      // pre-generated synthetic `taskRunId` (minted at :277) as the reply-event /
      // cost-ledger run id so the copilot_user_ask → copilot_reply evidence chain
      // stays uniform with teaching/solve. The quiz reply is one-shot: it carries
      // NO turn_kind and NO skill_turn (the /practice link rides in reply_md, which
      // the Dock already renders — zero new UI/replay plumbing).
      //
      // ONE-SHOT-END (deferred → YUK-213, bot-review F2): like the solve branch,
      // this returns no terminal `skill_turn`, so the Dock only clears
      // activeSkillRef on `skill_turn.kind==='end'` (CopilotDock.tsx). Once a quiz
      // context is seeded (see YUK-269) every follow-up message would keep
      // re-sending skill_context:{skill:'quiz'}. One-shot-skill turn semantics
      // (emit a terminal skill_turn, or have the Dock clear on one-shot skills)
      // are owned by YUK-213 and should be resolved together with the seeding
      // design — pre-existing for solve, currently unreachable for quiz.
      //
      // SEEDING GAP (deferred → YUK-269, bot-review F1): this branch only fires
      // when a `skill_context:{skill:'quiz'}` already arrives. No UI/server path
      // currently SEEDS it (the sole openCopilotWith call seeds 'teaching'), and
      // the route does NO intent classification — both deliberately OUT of this
      // lane's plan (§2.1/§4: "no Dock change", "NOT LLM classification"). So a
      // bare natural-language quiz request still falls through to the free-form
      // CopilotTask path. Wiring a producer (quiz chip / composer intent) is
      // tracked in YUK-269; until then YUK-262 is NOT end-to-end (PR #342 trailer
      // is `Refs YUK-262`, not `Closes`).
      const skillResult: QuizSkillResult = await runQuizSkillFn({
        db,
        sessionId,
        knowledgeId: req.skill_context.ref.id,
        userMessage: req.user_message,
      });
      replyMd = skillResult.text_md;
      realTaskRunId = taskRunId;

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
          // Synthetic run id (no LLM run on the quiz path — see block comment above).
          task_run_id: realTaskRunId,
          in_reply_to_event_id: causedByEventId ?? null,
          // PR round-2 (CR 3360614441): persist skill_context so replay can
          // restore the skill card (Dock chip renderer + replayToMessages use it).
          skill_context: req.skill_context,
        },
        caused_by_event_id: causedByEventId ?? null,
        task_run_id: realTaskRunId,
        created_at: replyAt,
      });
    } else {
      // PR #342 bot-review (OCR/Codex F4): exhaustive guard. `skill` is
      // z.enum(COPILOT_SKILL_KINDS) (validated at the route boundary), so the
      // three branches above are exhaustive today and this `else` is unreachable
      // at runtime. It exists so that a FUTURE 4th skill kind fails loudly here
      // in dev instead of silently mis-routing into the quiz path.
      throw new Error(`Unhandled copilot skill kind: ${req.skill_context.skill}`);
    }

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
      ...(skillTurn ? { skill_turn: skillTurn } : {}),
    };
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

  const result = await run(
    'CopilotTask',
    {
      surface,
      triggered_by: req.triggered_by,
      user_message: req.user_message,
      ...(req.chip_kind ? { chip_kind: req.chip_kind } : {}),
      // Edge-scoped, char-bounded reason digest. Serialized verbatim into the
      // prompt by promptFromInput (runner.ts JSON.stringify) — no new plumbing.
      proposal_feedback: proposalFeedback,
    },
    {
      db,
      mcpServers,
      allowedTools,
    },
  );

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
      reply_md: result.text,
      task_run_id: result.task_run_id,
      in_reply_to_event_id: causedByEventId ?? null,
    },
    caused_by_event_id: causedByEventId ?? null,
    task_run_id: result.task_run_id,
    created_at: replyAt,
  });

  return {
    task_run_id: result.task_run_id,
    reply: result.text,
    surface,
    triggered_by: req.triggered_by,
    session_id: sessionId,
    reply_event_id: replyEventId,
    ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
  };
}
