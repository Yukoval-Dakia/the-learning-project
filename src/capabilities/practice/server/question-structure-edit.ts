import type { QuestionEditOpT } from '@/core/schema/proposal';
import {
  StructuredQuestion,
  type StructuredQuestionT,
  findStructuredNode,
} from '@/core/schema/structured_question';

/**
 * Copy each visited node and its immediate children, then mutate a matching node.
 * A match stops traversal below that node; otherwise recurse through every child,
 * including sibling branches without the target. Other field references remain
 * shared unless the edit replaces them.
 */
function mapStructuredNodeById(
  node: StructuredQuestionT,
  target: string,
  mutate: (n: StructuredQuestionT) => void,
): { tree: StructuredQuestionT; matched: boolean } {
  const clone: StructuredQuestionT = {
    ...node,
    sub_questions: node.sub_questions ? node.sub_questions.map((s) => ({ ...s })) : undefined,
  };
  if (clone.id === target) {
    mutate(clone);
    return { tree: clone, matched: true };
  }
  let matched = false;
  if (clone.sub_questions) {
    clone.sub_questions = clone.sub_questions.map((sub) => {
      const res = mapStructuredNodeById(sub, target, mutate);
      if (res.matched) matched = true;
      return res.tree;
    });
  }
  return { tree: clone, matched };
}

// The narrow set of structured-node fields a question_edit op may touch, plus
// provenance. Snapshotted before/after for the reversible audit event.
type NodeEditableSnapshot = Pick<
  StructuredQuestionT,
  'prompt_text' | 'answers' | 'analysis' | 'options' | 'kind'
>;

function snapshotNode(node: StructuredQuestionT): NodeEditableSnapshot {
  return {
    prompt_text: node.prompt_text,
    answers: node.answers,
    analysis: node.analysis,
    options: node.options,
    kind: node.kind,
  };
}

export type QuestionEditGateFailure =
  | 'node_not_found'
  | 'not_a_leaf' // set_choice targets a stem (only leaf/standalone carry options)
  | 'empty_edit' // edit_reference with neither answers nor analysis
  | 'invalid_structure'; // post-edit tree fails the StructuredQuestion invariants

export interface QuestionEditApplyResult {
  tree: StructuredQuestionT;
  before: NodeEditableSnapshot;
  after: NodeEditableSnapshot;
}

/**
 * Mini post-edit verify gate + apply. PURE — no IO. Returns the proposed tree on
 * success, or a typed failure code (the applier rejects without writing). The
 * gate enforces:
 * 1. the target node exists (node_not_found);
 * 2. op-specific node-shape constraints (set_choice → leaf only; edit_reference
 * → at least one of answers/analysis);
 * 3. the resulting whole tree still satisfies the recursive StructuredQuestion
 * schema (e.g. only a stem may carry sub_questions) — re-parsed, so a bad
 * edit can never corrupt the persisted invariant.
 */
export function applyQuestionEdit(
  tree: StructuredQuestionT,
  edit: QuestionEditOpT,
  actorRef: string,
): QuestionEditApplyResult | { failure: QuestionEditGateFailure } {
  const target = findStructuredNode(tree, edit.node_id);
  if (!target) return { failure: 'node_not_found' };
  const before = snapshotNode(target);

  // Op-specific pre-conditions (gate part 1+2).
  if (edit.op === 'set_choice') {
    const isLeaf = target.role !== 'stem';
    if (!isLeaf) return { failure: 'not_a_leaf' };
  }
  if (edit.op === 'edit_reference' && edit.answers === undefined && edit.analysis === undefined) {
    return { failure: 'empty_edit' };
  }

  const { tree: nextTree, matched } = mapStructuredNodeById(tree, edit.node_id, (n) => {
    switch (edit.op) {
      case 'edit_node_text':
        n.prompt_text = edit.prompt_text;
        break;
      case 'edit_reference':
        if (edit.answers !== undefined) n.answers = [...edit.answers];
        if (edit.analysis !== undefined) n.analysis = edit.analysis;
        break;
      case 'set_choice':
        n.options = edit.options.map((o) => ({ label: o.label, text: o.text }));
        break;
      case 'set_node_kind':
        n.kind = edit.kind;
        break;
    }
    n.source = 'agent_edit';
    n.last_modified_by = actorRef;
  });
  // matched is guaranteed (findStructuredNode already hit), but keep the gate honest.
  if (!matched) return { failure: 'node_not_found' };

  // Gate part 3 — the resulting tree must still be a valid StructuredQuestion.
  const parsed = StructuredQuestion.safeParse(nextTree);
  if (!parsed.success) return { failure: 'invalid_structure' };

  const editedNode = findStructuredNode(nextTree, edit.node_id);
  // editedNode is present (we just mutated it); snapshot the after-state.
  const after = editedNode ? snapshotNode(editedNode) : before;
  return { tree: nextTree, before, after };
}
