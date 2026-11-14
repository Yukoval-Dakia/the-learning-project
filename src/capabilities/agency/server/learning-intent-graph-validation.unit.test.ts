import { describe, expect, it } from 'vitest';
import { checkProposalGraph, checkProposalPrerequisites } from './learning-intent-graph-validation';

const graph = { rootKey: 'root', childKeys: ['first', 'second'] };
const atomic = (knowledge_id: string, prerequisites: string[] = []) => ({
  knowledge_id,
  title: knowledge_id,
  one_line_intent: 'learn',
  prerequisite_knowledge_ids: prerequisites,
});
const long = (knowledge_ids: string[], prerequisites: string[] = []) => ({
  knowledge_ids,
  title: `long:${knowledge_ids.join(',')}`,
  one_line_intent: 'learn',
  prerequisite_knowledge_ids: prerequisites,
});

describe('learning intent prerequisite validation', () => {
  // @invariant data: a long's declared prerequisites validate every knowledge id it cites
  // @fails-if only knowledge_ids[0] is checked and a legal edge for the cited long is rejected
  it('accepts long prerequisites for every cited knowledge id', () => {
    const atomics = [atomic('first'), atomic('second')];
    const longs = [long(['first', 'second'], ['root'])];
    const edges = [{ prerequisite_knowledge_id: 'root', dependent_knowledge_id: 'first' }];
    expect(checkProposalGraph(graph, atomics, longs, edges)).toBeNull();
    expect(checkProposalPrerequisites(graph, atomics, longs, edges)).toEqual({ type: 'ok' });
  });

  // @invariant data: prerequisite graph ordering rejects a dependent emitted before its prerequisite
  // @fails-if an existing edge is accepted without enforcing the plan's topological order
  it('rejects a dependent ordered before its prerequisite', () => {
    const badGraph = { rootKey: 'root', childKeys: ['second', 'first'] };
    const atomics = [atomic('second', ['first']), atomic('first')];
    const edges = [{ prerequisite_knowledge_id: 'first', dependent_knowledge_id: 'second' }];
    expect(checkProposalGraph(badGraph, atomics, [], edges)).toBeNull();
    expect(checkProposalPrerequisites(badGraph, atomics, [], edges)).toEqual({
      type: 'order',
      prerequisite: 'first',
      dependent: 'second',
    });
  });
});
