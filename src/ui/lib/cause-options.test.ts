import { describe, expect, it } from 'vitest';

import { causeOptionsForSelectedKnowledge } from './cause-options';

const nodes = [
  { id: 'k_wenyan', name: '虚词', effective_domain: 'wenyan' },
  { id: 'k_math', name: '单位换算', effective_domain: 'math' },
];

describe('causeOptionsForSelectedKnowledge', () => {
  it('uses the selected knowledge effective domain to expose math cause options', () => {
    const options = causeOptionsForSelectedKnowledge(nodes, ['k_math']);
    const ids = options.map((option) => option.id);

    expect(ids).toContain('unit_error');
    expect(ids).toContain('time_pressure');
  });

  it('falls back to the default subject cause options when no knowledge is selected', () => {
    const options = causeOptionsForSelectedKnowledge(nodes, []);
    const ids = options.map((option) => option.id);

    expect(ids).toContain('concept');
    expect(ids).toContain('carelessness');
    expect(ids).not.toContain('unit_error');
  });
});
