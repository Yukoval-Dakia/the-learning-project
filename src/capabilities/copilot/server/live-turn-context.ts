import type { CopilotRunInput } from './copilot-run-input';

export const COPILOT_TURN_CONTEXT_OPEN = '<turn_context>';
export const COPILOT_TURN_CONTEXT_CLOSE = '</turn_context>';
export const COPILOT_TURN_CONTEXT_CODEC_VERSION = 'copilot-live-turn-v2';

type TurnContext = {
  readonly v: 1;
  readonly learner_state?: string;
  readonly proposal_feedback?: CopilotRunInput['proposal_feedback'];
  readonly ambient?: CopilotRunInput['ambient_context'];
  readonly chip?: {
    readonly surface: CopilotRunInput['surface'];
    readonly kind?: string;
  };
  readonly correction_contract?: CopilotRunInput['correction_contract'];
};

export function compileCopilotModelInput(
  input: CopilotRunInput,
  mode: 'cold' | 'resume',
  options: { includeProposalFeedback?: boolean } = {},
): string {
  if (mode === 'cold') {
    const {
      learner_state_header: _learnerStateHeader,
      validator_context_history: _validatorContextHistory,
      ...boundedEnvelope
    } = input;
    return JSON.stringify(boundedEnvelope);
  }

  const context = compileTurnContext(input, options.includeProposalFeedback !== false);
  return context ? `${context}\n${input.user_message}` : input.user_message;
}

function compileTurnContext(input: CopilotRunInput, includeProposalFeedback: boolean): string {
  const context: TurnContext = {
    v: 1,
    ...(input.learner_state_header ? { learner_state: input.learner_state_header } : {}),
    ...(includeProposalFeedback && input.proposal_feedback.length > 0
      ? { proposal_feedback: input.proposal_feedback }
      : {}),
    ...(input.ambient_context ? { ambient: input.ambient_context } : {}),
    ...(input.triggered_by === 'chip'
      ? {
          chip: {
            surface: input.surface,
            ...(input.chip_kind ? { kind: input.chip_kind } : {}),
          },
        }
      : {}),
    ...(input.correction_contract.target_prior_turn_id
      ? {
          correction_contract: input.correction_contract,
        }
      : {}),
  };

  if (Object.keys(context).length === 1) return '';
  return `${COPILOT_TURN_CONTEXT_OPEN}${JSON.stringify(context)}${COPILOT_TURN_CONTEXT_CLOSE}`;
}

/** The bounded sidecar reintroduced by native SDK compaction. */
export function compileCopilotSessionContext(input: CopilotRunInput): string {
  return compileTurnContext(input, true);
}
