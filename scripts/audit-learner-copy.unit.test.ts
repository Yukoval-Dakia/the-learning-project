import { describe, expect, it } from 'vitest';
import {
  type CopyAllowlistEntry,
  applyCopyAllowlist,
  scanLearnerCopy,
  validateCopyAllowlist,
} from './audit-learner-copy';

describe('learner-copy usability gate', () => {
  it('detects migration labels, disconnected actions, and dead placeholder handlers', () => {
    const violations = scanLearnerCopy(
      'fixture.tsx',
      [
        '<p>M5 暂未接线</p>',
        'const placeholder = (text: string) => setToast(`成功：${text}`);',
      ].join('\n'),
    );

    expect(violations.map((violation) => violation.label)).toEqual([
      'migration milestone',
      'disconnected action copy',
      'dead placeholder action',
    ]);
  });

  it('ignores comment-only implementation language', () => {
    expect(
      scanLearnerCopy(
        'fixture.tsx',
        ['// M5 暂未接线', "/* const placeholder = () => setToast('假成功') */"].join('\n'),
      ),
    ).toEqual([]);
  });

  it('requires a reasoned exact allowlist and rejects stale entries', () => {
    const [violation] = scanLearnerCopy('fixture.tsx', '<p>M4</p>');
    expect(violation).toBeDefined();
    const entry: CopyAllowlistEntry = {
      file: 'fixture.tsx',
      label: 'migration milestone',
      valueIncludes: '<p>M4</p>',
      reason: 'Fixture proving the allowlist contract.',
    };

    expect(applyCopyAllowlist([violation], [entry])).toEqual({
      violations: [],
      staleEntries: [],
    });
    expect(applyCopyAllowlist([], [entry]).staleEntries).toEqual([entry]);
    expect(() => validateCopyAllowlist([{ ...entry, reason: '' }])).toThrow(/empty reason/);
  });
});
