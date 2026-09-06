import { describe, expect, it } from 'vitest';
import { CopilotToolResultSnapshotSchema } from '../primary-view-contract';
import { buildCopilotToolResultSnapshot, requiresToolResultLearningValidation } from './tool-result-snapshot';

describe('Copilot tool result snapshot', () => {
  it('projects typed evidence and preserves falsy values and claim boundaries', () => {
    const snapshot = buildCopilotToolResultSnapshot('query_knowledge', {
      nodes: [{ id: 'n1', name: '函数', score: 0, approved: false, evidence: null, children: [] }],
      coverage: { observed: 0, has_more: false }, context_budget: { remaining: 0 },
      raw: 'secret', diagnostic: { provider: 'x' },
    });
    expect(snapshot.state).toBe('available');
    if (snapshot.state === 'available') {
      expect(snapshot.value).toMatchObject({ nodes: [{ score: 0, approved: false, evidence: null, children: [] }], coverage: { observed: 0, has_more: false } });
      expect(snapshot.omissions.some((x) => x.path === '/raw')).toBe(true);
      expect(CopilotToolResultSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
  });

  it('suppresses opaque/private subtrees and generated text needs validation', () => {
    const snapshot = buildCopilotToolResultSnapshot('get_attempt_context', { id: 'a1', answer: 'ok', grading: { rubric: 'private' }, raw: 'x' });
    expect(snapshot).toMatchObject({ state: 'available', completeness: 'projected' });
    expect(requiresToolResultLearningValidation('mcp__loom__generate_question_candidate')).toBe(true);
    expect(requiresToolResultLearningValidation('query_knowledge')).toBe(false);
  });

  it('keeps natural lists bounded and reports omissions truthfully', () => {
    const snapshot = buildCopilotToolResultSnapshot('query_events', { events: Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, summary: 'x'.repeat(80) })) });
    expect(snapshot.state).toBe('available');
    if (snapshot.state === 'available') expect(snapshot.omissions.find((x) => x.path === '/events')?.omitted_count).toBeGreaterThan(0);
  });

  it('rejects control, internal, and unknown results', () => {
    expect(buildCopilotToolResultSnapshot('present_primary_view', {})).toEqual({ version: 1, state: 'unavailable', reason: 'internal_only' });
    expect(buildCopilotToolResultSnapshot('write_agent_note', {})).toMatchObject({ state: 'unavailable', reason: 'internal_only' });
    expect(buildCopilotToolResultSnapshot('new_tool', {})).toMatchObject({ state: 'unavailable', reason: 'unsupported_result' });
  });

  it('captures an immutable clone', () => {
    const output = { id: 'x', nested: { value: 1 } };
    const snapshot = buildCopilotToolResultSnapshot('query_records', output);
    output.nested.value = 9;
    expect(snapshot.state === 'available' && snapshot.value).toMatchObject({ nested: { value: 1 } });
  });
});
