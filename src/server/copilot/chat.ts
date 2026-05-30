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

import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolSurface,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { resolveContextBudget } from '@/server/ai/tools/budgets';
import { ContextBudgetTracker } from '@/server/ai/tools/context-throttle';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';

export const COPILOT_CHAT_TRIGGER_KINDS = ['chat', 'chip'] as const;
export type CopilotChatTriggerKind = (typeof COPILOT_CHAT_TRIGGER_KINDS)[number];

export const CopilotChatRequest = z.object({
  user_message: z.string().min(1).max(4000),
  triggered_by: z.enum(COPILOT_CHAT_TRIGGER_KINDS),
  /**
   * Optional identifier for chip-driven flows, e.g. 'out_3_variants'.
   * Stored on the chip-trigger event so downstream can analyse usage.
   */
  chip_kind: z.string().min(1).max(80).optional(),
});

export type CopilotChatRequestT = z.infer<typeof CopilotChatRequest>;

export interface CopilotChatResult {
  task_run_id: string;
  reply: string;
  surface: DomainToolSurface;
  triggered_by: CopilotChatTriggerKind;
  /** When the chat path wrote a user_ask event, this carries the id. */
  user_ask_event_id?: string;
}

const CHIP_TRIGGER_EVENT_ACTION = 'experimental:copilot_chip_trigger';
const USER_ASK_EVENT_ACTION = 'experimental:copilot_user_ask';

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer>;
    allowedTools?: string[];
  },
) => Promise<RunTaskResult>;
type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;

export interface CopilotChatDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  now?: () => Date;
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
  const write = deps.writeEventFn ?? writeEvent;

  const surface = selectSurface(req.triggered_by);
  const actorRef = selectActorRef(req.triggered_by);
  const taskRunId = `copilot_task_${createId()}`;
  let causedByEventId: string | undefined;
  let userAskEventId: string | undefined;

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
      actor_kind: 'user',
      actor_ref: 'user:self',
      action: USER_ASK_EVENT_ACTION,
      subject_kind: 'query',
      subject_id: userAskEventId,
      outcome: null,
      payload: {
        surface: 'copilot',
        user_message: req.user_message,
      },
      created_at: now,
    });
    causedByEventId = userAskEventId;
  } else {
    const chipEventId = `copilot_chip_${createId()}`;
    await write(db, {
      id: chipEventId,
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
      },
      created_at: now,
    });
    causedByEventId = chipEventId;
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
      const { args: capped, truncation } = budgetTracker.capInput(tool.name, args);
      return { args: capped, truncationNote: truncation };
    },
  });

  const result = await run(
    'CopilotTask',
    {
      surface,
      triggered_by: req.triggered_by,
      user_message: req.user_message,
      ...(req.chip_kind ? { chip_kind: req.chip_kind } : {}),
    },
    {
      db,
      mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
      allowedTools: [...resolveMcpAllowedTools(surface)],
    },
  );

  return {
    task_run_id: result.task_run_id,
    reply: result.text,
    surface,
    triggered_by: req.triggered_by,
    ...(userAskEventId ? { user_ask_event_id: userAskEventId } : {}),
  };
}
