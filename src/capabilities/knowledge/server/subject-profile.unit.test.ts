import { beforeEach, describe, expect, it, vi } from 'vitest';

const domain = vi.hoisted(() => ({
  getEffectiveDomain: vi.fn(),
}));

vi.mock('./domain', () => ({
  getEffectiveDomain: domain.getEffectiveDomain,
}));

import { requireSubjectProfileForKnowledgeIds } from './subject-profile';

describe('requireSubjectProfileForKnowledgeIds', () => {
  beforeEach(() => {
    domain.getEffectiveDomain.mockReset();
  });

  it('resolves a genuine registered profile or alias', async () => {
    domain.getEffectiveDomain.mockResolvedValue('wenyan');

    await expect(
      requireSubjectProfileForKnowledgeIds({} as never, ['kc-classical']),
    ).resolves.toMatchObject({ id: 'yuwen' });
  });

  it('fails provenance-sensitive work for an unregistered effective domain', async () => {
    domain.getEffectiveDomain.mockResolvedValue('custom-skipped-invalid');

    await expect(requireSubjectProfileForKnowledgeIds({} as never, ['kc-custom'])).rejects.toThrow(
      "effective domain 'custom-skipped-invalid' for knowledge 'kc-custom' has no registered subject profile",
    );
  });
});
