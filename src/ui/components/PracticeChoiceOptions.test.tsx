// YUK-261 — static render assertions for PracticeChoiceOptions.
// renderToString only (no DOM / no click simulation) → unit partition.
// Click/keyboard behaviour is covered by practice-choice-logic.test.ts.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PracticeChoiceOptions } from './PracticeChoiceOptions';

const CHOICES = ['宾语前置', '定语后置', '状语后置', '判断句'];
const noop = () => {};

describe('PracticeChoiceOptions render', () => {
  it('renders one focusable group with A-D labelled option buttons', () => {
    const html = renderToString(
      <PracticeChoiceOptions choices={CHOICES} value="" multiSelect={false} onSelect={noop} />,
    );
    expect(html).toContain('practice-choices--clickable');
    expect(html).toContain('role="group"');
    expect(html).toContain('>A<');
    expect(html).toContain('>D<');
    expect(html).toContain('宾语前置');
    // four option buttons.
    expect(html.match(/practice-choice-btn/g)?.length).toBe(4);
  });

  it('marks the selected option with aria-pressed + ✓ icon class (non-colour cue)', () => {
    const html = renderToString(
      <PracticeChoiceOptions choices={CHOICES} value="A" multiSelect={false} onSelect={noop} />,
    );
    expect(html).toContain('is-selected');
    expect(html).toContain('aria-pressed="true"');
    // the check-mark span renders only on the selected card.
    expect(html).toContain('practice-choice-mark');
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(3);
  });

  it('reflects a multi-select value (BC) as two pressed options', () => {
    const html = renderToString(
      <PracticeChoiceOptions choices={CHOICES} value="BC" multiSelect onSelect={noop} />,
    );
    expect(html).toContain('aria-multiselectable="true"');
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(2);
  });

  it('disables all option buttons in read-only mode (no focusable group)', () => {
    const html = renderToString(
      <PracticeChoiceOptions
        choices={CHOICES}
        value="A"
        multiSelect={false}
        disabled
        onSelect={noop}
      />,
    );
    expect(html.match(/disabled/g)?.length).toBe(4);
    // group is not keyboard-focusable when non-interactive.
    expect(html).not.toContain('tabindex="0"');
  });

  it('shows feedback ✓ on the correct chosen option and ✗ on a wrong one', () => {
    // user chose B; reference is A → B wrong, A is the missed correct answer.
    const html = renderToString(
      <PracticeChoiceOptions
        choices={CHOICES}
        value="B"
        multiSelect={false}
        feedback
        reference="A"
        onSelect={noop}
      />,
    );
    // wrong chosen option carries the wrong tone + ✗ aria-label.
    expect(html).toContain('is-wrong');
    expect(html).toContain('错误选项');
    // missed correct option carries the correct/missed tone + ✓ aria-label.
    expect(html).toContain('is-missed');
    expect(html).toContain('正确选项');
    // feedback mode locks interaction.
    expect(html.match(/disabled/g)?.length).toBe(4);
  });

  it('shows feedback ✓ when the chosen option matches the reference', () => {
    const html = renderToString(
      <PracticeChoiceOptions
        choices={CHOICES}
        value="A"
        multiSelect={false}
        feedback
        reference="A"
        onSelect={noop}
      />,
    );
    expect(html).toContain('is-correct');
    expect(html).toContain('正确选项');
    expect(html).not.toContain('is-wrong');
  });
});
