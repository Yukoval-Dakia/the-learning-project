// Frozen question materials may carry a static plot, never learner params.
// Kept out of question-draft-contract.ts so that file stays below the
// capability-boundary line budget; the contract imports this one check.

import { findPlotParamFences } from '@/core/schema/blocks/plot-fence';
import type { QuestionDraftDocumentT } from '@/core/schema/question-draft';

export type QuestionMaterialGateIssue = {
  readonly code: 'question_material_plot_params';
  readonly detail: string;
};

export function questionMaterialPlotParamIssues(
  doc: QuestionDraftDocumentT,
): QuestionMaterialGateIssue[] {
  const issues: QuestionMaterialGateIssue[] = [];
  for (const material of doc.materials) {
    if (material.content_md == null || material.content_md.length === 0) continue;
    const fences = findPlotParamFences(material.content_md);
    if (fences.length > 0) {
      issues.push({
        code: 'question_material_plot_params',
        detail: `material '${material.material_id}' has plot fence(s) ${fences.join(', ')} with params; params are forbidden in a frozen question material`,
      });
    }
  }
  return issues;
}
