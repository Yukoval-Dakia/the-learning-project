import { z } from 'zod';

export const COPILOT_CHAT_TRIGGER_KINDS = ['chat', 'chip'] as const;
export type CopilotChatTriggerKind = (typeof COPILOT_CHAT_TRIGGER_KINDS)[number];

// Wire-wide values stay backward-compatible even though only teaching remains
// a server-side behavior pack. Persisted solve/quiz contexts must keep parsing.
export const COPILOT_SKILL_CONTEXT_KINDS = ['teaching', 'solve', 'quiz'] as const;
export type CopilotSkillContextKind = (typeof COPILOT_SKILL_CONTEXT_KINDS)[number];
export const COPILOT_BEHAVIOR_PACK_KINDS = ['teaching'] as const;
export type CopilotBehaviorPackKind = (typeof COPILOT_BEHAVIOR_PACK_KINDS)[number];

export const CopilotSkillContext = z.object({
  skill: z.enum(COPILOT_SKILL_CONTEXT_KINDS),
  ref: z.object({
    kind: z.string().min(1).max(40),
    id: z.string().min(1).max(120),
  }),
});
export type CopilotSkillContextT = z.infer<typeof CopilotSkillContext>;

/** Existing product-state carrier shared by inline, durable, and replay paths. */
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

/** The persisted pair needed to interpret a skill turn after reconnect/replay. */
export interface CopilotModeState {
  skill_turn: CopilotSkillTurn;
  skill_context: CopilotSkillContextT;
}

/** Narrow the persisted teaching projection identically for history and live recovery. */
export function readCopilotSkillTurn(
  payload: Record<string, unknown>,
): CopilotSkillTurn | undefined {
  const st = payload.skill_turn;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return undefined;
  const s = st as Record<string, unknown>;
  const kind = s.kind;
  if (kind !== 'explain' && kind !== 'ask_check' && kind !== 'end') return undefined;
  const result: CopilotSkillTurn = { kind };
  if (s.suggested_next === 'continue' || s.suggested_next === 'end')
    result.suggested_next = s.suggested_next;
  if (s.structured_question && typeof s.structured_question === 'object') {
    const sq = s.structured_question as Record<string, unknown>;
    if (
      typeof sq.id === 'string' &&
      typeof sq.kind === 'string' &&
      typeof sq.prompt_md === 'string'
    ) {
      const rawChoices = sq.choices_md;
      result.structured_question = {
        id: sq.id,
        kind: sq.kind,
        prompt_md: sq.prompt_md,
        choices_md:
          Array.isArray(rawChoices) && rawChoices.every((el) => typeof el === 'string')
            ? rawChoices
            : null,
      };
    }
  }
  return result;
}

export const CopilotChatRequest = z
  .object({
    session_id: z.string().min(1).max(160).optional(),
    user_message: z.string().min(1).max(4000),
    triggered_by: z.enum(COPILOT_CHAT_TRIGGER_KINDS),
    chip_kind: z.string().min(1).max(80).optional(),
    skill_context: CopilotSkillContext.optional(),
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
    durable: z.boolean().optional(),
    correction_target_turn_id: z.string().min(1).max(160).optional(),
  })
  .superRefine((request, ctx) => {
    if (
      request.correction_target_turn_id !== undefined &&
      request.skill_context?.skill === 'teaching'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['correction_target_turn_id'],
        message: 'correction_target_turn_id is not supported for teaching behavior packs',
      });
    }
  });

export type CopilotChatRequestT = z.infer<typeof CopilotChatRequest>;
