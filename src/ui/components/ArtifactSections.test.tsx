import type { SlimSubjectProfile } from '@/ui/lib/subject';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type ArtifactSection, ArtifactSections } from './ArtifactSections';

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
});
