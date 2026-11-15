// Ordered goal_scope presentation: resolve knowledge labels once for the inbox
// and keep the ordered path visible as learner-editable data.

import type { ProposalPresentation, ProposalPresentationInput } from './presentation';

export async function enrichGoalScopePresentation(
  proposal: ProposalPresentationInput,
  presentation: ProposalPresentation | undefined,
  readNames: (ids: readonly string[]) => Promise<Map<string, string>>,
): Promise<void> {
  if (proposal.payload.kind !== 'goal_scope' || !presentation) return;
  const ordered = proposal.payload.proposed_change.ordered_scope ?? [];
  if (ordered.length === 0) return;
  const names = await readNames(ordered.map((point) => point.knowledge_id));
  presentation.goal_scope = {
    ordered_points: [...ordered]
      .sort((a, b) => a.order - b.order)
      .map((point) => ({
        knowledge_id: point.knowledge_id,
        label: names.get(point.knowledge_id) ?? point.knowledge_id.slice(0, 8),
        order: point.order,
      })),
  };
}
