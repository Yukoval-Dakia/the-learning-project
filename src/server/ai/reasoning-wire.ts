/**
 * Single source for how a resolved task reasoning outcome reaches the wire.
 * The adapter applies the model view to the request's pi model; the reopen
 * preflight reads the same fields to predict the payload — they must not
 * drift.
 *
 * pi's thinking-format branches treat "no reasoningEffort set" and
 * "reasoningEffort disabled" identically when `thinkingLevelMap.off !==
 * null` (it emits `thinking:{disabled}` / `reasoning:{effort:'none'}`).
 * Scoping `off` to the actual 'off' outcome is the only way an
 * unconfigured run stays identical to main (no reasoning field at all,
 * provider default applies).
 */
import type { ResolvedTaskReasoning } from './providers';

/**
 * Wire fields pi emits for a resolved reasoning outcome (deepseek-format
 * lanes; other formats carry no vendor field). Kept beside
 * `reasoningModelView` so preflight and production share one source — a
 * change to either must stay consistent here.
 */
export function reasoningWireFields(
  reasoning: ResolvedTaskReasoning,
  thinkingFormat: string | undefined,
  api?: string,
): Record<string, unknown> {
  if (reasoning.applied === 'on') {
    // Toggle: the carrier level reaches pi's reasoningEffort slot, so the wire
    // is pi's effort-set shape for the lane's format (openai-completions.js
    // thinking-format branches / anthropic driver). Predictions assume
    // undeclared compat — pi's detected defaults, which live lanes use.
    if (reasoning.level === undefined) return {};
    if (api === 'anthropic-messages') return { thinking: { type: 'enabled' } };
    switch (thinkingFormat) {
      case 'deepseek':
        return { reasoning_effort: reasoning.level, thinking: { type: 'enabled' } };
      case 'zai':
        return { thinking: { type: 'enabled', clear_thinking: false } };
      case 'qwen':
        return { enable_thinking: true, reasoning_effort: reasoning.level };
      case 'qwen-chat-template':
        return { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } };
      case 'openrouter':
        return { reasoning: { effort: reasoning.level } };
      case 'together':
        return { reasoning: { enabled: true } };
      case 'string-thinking':
        return { thinking: reasoning.level };
      case 'ant-ling':
        // pi sends reasoning:{effort} only when the model's thinkingLevelMap
        // maps the level — invisible here, predicted as mapped-through.
        return { reasoning: { effort: reasoning.level } };
      default:
        // 'openai'/unset and remaining formats take pi's generic effort field;
        // baseten/chat-template also emit template args this helper can't see.
        return { reasoning_effort: reasoning.level };
    }
  }
  if (reasoning.applied === 'none') return {};
  if (reasoning.applied === 'off') {
    if (thinkingFormat === 'deepseek' || api === 'anthropic-messages') {
      return { thinking: { type: 'disabled' } };
    }
    if (thinkingFormat === 'openrouter') return { reasoning: { effort: 'none' } };
    return {};
  }
  if (reasoning.level === undefined) return {};
  return thinkingFormat === 'deepseek'
    ? { reasoning_effort: reasoning.applied, thinking: { type: 'enabled' } }
    : { reasoning_effort: reasoning.applied };
}

export interface ReasoningWireModel {
  thinkingLevelMap?: Record<string, string | null>;
  overrideDeclaredThinkingFormat?: string;
}

/**
 * Returns a request-scoped view of the pi model with `thinkingLevelMap`
 * adjusted for THIS run's reasoning outcome. pi reads only `?.off !== null`
 * for the no-effort branch, so `off: null` suppresses the field while a
 * defined value keeps the disable shape reachable.
 */
export function reasoningModelView<T extends ReasoningWireModel>(
  model: T,
  reasoning: ResolvedTaskReasoning | undefined,
  effortOption: string | undefined,
): T {
  const map = model.thinkingLevelMap;
  // Only lanes whose thinkingFormat our overrides introduce need correction:
  // main sent no reasoning field for them, while pi 1.5.0's new format branch
  // would emit a disable. Lanes with builtin-declared formats keep pi's
  // default wire exactly as main had it (e.g. anthropic, token-plan mimo
  // both sent thinking:{disabled} on unset in 1.1.0).
  if (model.overrideDeclaredThinkingFormat === undefined) return model;
  // 'none' means no reasoning parameter by design — identical to unset.
  if ((reasoning === undefined && effortOption === undefined) || reasoning?.applied === 'none') {
    // Unconfigured run — identical to main: no reasoning field on the wire.
    // `off: null` is required even when the lane has no map at all (toggle
    // lanes carry no thinkingLevelMap): pi's `?.off !== null` check emits the
    // disabled shape unless `off` is explicitly null.
    return { ...model, thinkingLevelMap: { ...map, off: null } };
  }
  if (reasoning?.applied === 'off') {
    // Explicit off — the disable shape must be expressible.
    return { ...model, thinkingLevelMap: { ...map, off: 'disabled' } };
  }
  return model;
}
