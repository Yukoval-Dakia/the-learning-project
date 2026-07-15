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

export const CopilotChatRequest = z.object({
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
});

export type CopilotChatRequestT = z.infer<typeof CopilotChatRequest>;
