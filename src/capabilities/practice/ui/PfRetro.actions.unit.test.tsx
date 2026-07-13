import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PfrQRow } from './PfRetro';
import type { PaperSlot } from './practice-api';

const incorrectSlot: PaperSlot = {
  question_id: 'q-wrong',
  part_ref: null,
  section_index: 0,
  question: {
    id: 'q-wrong',
    kind: 'choice',
    prompt_md: '哪一项正确？',
    choices_md: ['A', 'B'],
    difficulty: 2,
  },
  slot_state: {
    draft: null,
    submission: {
      submitted: true,
      visible_to_user: true,
      outcome: 'incorrect',
      score: 0,
      feedback_md: '再想想。',
      answer_md: 'A',
      reference_md: 'B',
    },
  },
};

describe('PfRetro appeal honesty (YUK-626)', () => {
  it('shows an honest unavailable message and no fake rejudge action/state', () => {
    const html = renderToString(<PfrQRow n={1} slot={incorrectSlot} appealable />);
    expect(html).toContain('此处暂不能直接重判');
    expect(html).not.toContain('不服判？附理由重判');
    expect(html).not.toContain('重判中');
  });
});
