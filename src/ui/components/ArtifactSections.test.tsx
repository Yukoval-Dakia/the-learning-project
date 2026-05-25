import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type ArtifactSection,
  ArtifactSections,
  createOptimisticSectionEdit,
  getArtifactSectionEditMinHeight,
} from './ArtifactSections';

const wenyanProfile: SlimSubjectProfile = {
  id: 'wenyan',
  displayName: '文言文',
  renderConfig: { font_family: 'serif-cjk', notation: null, code_highlight: null },
};

const mathProfile: SlimSubjectProfile = {
  id: 'math',
  displayName: '数学',
  renderConfig: { font_family: 'sans', notation: 'latex', code_highlight: null },
};

const baseSection: Omit<ArtifactSection, 'id' | 'kind' | 'body_md'> = {
  source_tier: 'llm_only',
  user_verified: false,
  embedded_check: null,
  version: 1,
};

describe('ArtifactSections — markdown rendering wiring', () => {
  it('renders list / code / image inside atomic body via NoteRenderer', () => {
    const sections: ArtifactSection[] = [
      {
        ...baseSection,
        id: 's1',
        kind: 'mechanism',
        body_md: '- step one\n- step two\n\n```py\nprint("hi")\n```\n\n![fig](/x.png)',
      },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('note-prose');
    expect(html).toContain('artifact-section-body');
    expect(html).toContain('<ul>');
    expect(html).toMatch(/<li>step one<\/li>/);
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-py">');
    expect(html).toMatch(/<img[^>]+src="\/x\.png"/);
  });

  it('preserves KaTeX gating for math subject', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: '$E = mc^2$' },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={mathProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('class="katex"');
  });

  it('skips KaTeX for wenyan subject (raw $...$ stays as text)', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: '注释：$x$ 不是数学符号' },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('注释：');
  });

  it('renders section header label + tier label', () => {
    const sections: ArtifactSection[] = [
      {
        ...baseSection,
        id: 's1',
        kind: 'pitfall',
        body_md: 'careful',
        source_tier: 'textbook',
      },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('易错');
    expect(html).toContain('教材');
  });

  it('mounts embedded check questions only on check sections', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: 'definition' },
      {
        ...baseSection,
        id: 's2',
        kind: 'check',
        body_md: 'answer this',
        embedded_check: { question_ids: ['q1'] },
      },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={mathProfile}
        embeddedQuestions={[
          {
            id: 'q1',
            kind: 'single_choice',
            prompt_md: 'Which one equals $2^2$?',
            choices_md: ['3', '4'],
          },
        ]}
        embeddedCheckStatus="ready"
      />,
    );
    expect(html).toContain('自检题 · 1 题');
    expect(html).toContain('Which one equals');
    expect(html).toContain('class="katex"');
    expect(html.match(/自检题 · 1 题/g)).toHaveLength(1);
  });

  it('renders explicit edit controls when artifact id/version are provided', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: 'definition' },
    ];
    const html = renderToString(
      <ArtifactSections
        artifactId="a1"
        artifactVersion={0}
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('Edit');
    expect(html).toContain('artifact-section-edit-slot');
  });

  it('renders textarea + Save/Cancel in edit mode without dropping the stable slot', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: 'first line\nsecond line' },
    ];
    const html = renderToString(
      <ArtifactSections
        artifactId="a1"
        artifactVersion={0}
        initialEditingSectionId="s1"
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('<textarea');
    expect(html).toContain('first line');
    expect(html).toContain('Save');
    expect(html).toContain('Cancel');
    expect(html).toContain('artifact-section-edit-slot');
  });

  it('builds optimistic edit state and keeps a rollback snapshot', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: 'old', version: 2 },
      { ...baseSection, id: 's2', kind: 'example', body_md: 'other', version: 1 },
    ];

    const edit = createOptimisticSectionEdit({ artifactVersion: 5, sections }, 's1', 'new body');

    expect(edit.optimistic.artifactVersion).toBe(6);
    expect(edit.optimistic.sections[0]).toMatchObject({
      id: 's1',
      body_md: 'new body',
      version: 3,
    });
    expect(edit.optimistic.sections[1]).toBe(sections[1]);
    expect(edit.rollback.artifactVersion).toBe(5);
    expect(edit.rollback.sections[0]).toMatchObject({ id: 's1', body_md: 'old', version: 2 });
  });

  it('derives a bounded edit min-height from markdown shape', () => {
    expect(getArtifactSectionEditMinHeight('short')).toBeGreaterThanOrEqual(112);
    expect(
      getArtifactSectionEditMinHeight(Array.from({ length: 20 }, () => 'line').join('\n')),
    ).toBeLessThanOrEqual(360);
  });
});
