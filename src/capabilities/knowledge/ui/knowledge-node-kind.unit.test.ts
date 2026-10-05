import { describe, expect, it } from 'vitest';
import { isKnowledgeContainer } from './knowledge-node-kind';

describe('isKnowledgeContainer', () => {
  it('recognizes seeded subject roots only', () => {
    expect(isKnowledgeContainer({ id: 'seed:yuwen:root', parent_id: null })).toBe(true);
    expect(isKnowledgeContainer({ id: 'kc:root', parent_id: null })).toBe(false);
    expect(isKnowledgeContainer({ id: 'seed:yuwen:root', parent_id: 'parent' })).toBe(false);
  });
});
