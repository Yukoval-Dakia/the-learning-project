import { describe, expect, it } from 'vitest';
import { scanNoLearningStyles } from './audit-no-learning-styles';

describe('no-learning-styles audit', () => {
  it('detects English and Chinese learner-style personalization labels', () => {
    const violations = scanNoLearningStyles(
      'fixture.ts',
      [
        "const learner = 'visual learner';",
        "const model = 'VARK';",
        "const profile = '听觉型学习者';",
        "const strategy = '按学习风格教学';",
      ].join('\n'),
    );

    expect(violations.map((violation) => violation.label)).toEqual([
      'modality learner type',
      'VAK/VARK taxonomy',
      'Chinese modality learner type',
      'Chinese learning-style personalization',
    ]);
  });

  it('does not reject evidence-based state or explanation-mode labels', () => {
    expect(
      scanNoLearningStyles(
        'fixture.ts',
        [
          "const thetaBand = 'developing';",
          "const precisionBand = 'low';",
          "const explanationStyle = 'conceptual';",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('ignores comments that document the red line', () => {
    expect(
      scanNoLearningStyles(
        'fixture.ts',
        '// Do not personalize from learning styles or VARK labels.\nconst safe = true;',
      ),
    ).toEqual([]);
  });

  it('keeps comment markers inside string and template literals scannable', () => {
    const violations = scanNoLearningStyles(
      'fixture.ts',
      [
        "const url = 'https://site.com/learning-styles';",
        "const marker = 'start/*VARK*/end';",
        'const template = `https://site.com/visual learner`;',
        "const afterMarker = '听觉型学习者';",
      ].join('\n'),
    );

    expect(violations.map((violation) => violation.label)).toEqual([
      'learning-style personalization',
      'VAK/VARK taxonomy',
      'modality learner type',
      'Chinese modality learner type',
    ]);
  });

  it('still ignores comments inside template expressions', () => {
    expect(
      scanNoLearningStyles(
        'fixture.ts',
        'const value = `${1 /* visual learner and VARK */} safe`;',
      ),
    ).toEqual([]);
  });
});
