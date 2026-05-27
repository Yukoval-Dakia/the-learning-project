import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BlockTreeRenderer } from './BlockTreeRenderer';
import { paragraphNode, semanticBlockNode } from './pm';

const subjectProfile = {
  id: 'wenyan',
  displayName: '文言文',
  renderConfig: { font_family: 'serif-cjk', notation: 'wenyan', code_highlight: null },
};

describe('BlockTreeRenderer', () => {
  it('renders semantic blocks, inline marks, and correction state without editor imports', () => {
    const html = renderToStaticMarkup(
      <BlockTreeRenderer
        bodyBlocks={{
          type: 'doc',
          content: [
            semanticBlockNode(
              { id: 'def1', semantic_kind: 'definition', source_tier: 'textbook' },
              [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: '核心' },
                    { type: 'text', text: '概念', marks: [{ type: 'bold' }] },
                  ],
                },
              ],
            ),
            semanticBlockNode({ id: 'check1', semantic_kind: 'check' }, [paragraphNode('自检')]),
          ],
        }}
        subjectProfile={subjectProfile}
        embeddedCheckStatus="ready"
        embeddedQuestions={[
          {
            id: 'q1',
            kind: 'short_answer',
            prompt_md: '为什么？',
            choices_md: null,
          },
        ]}
        correctionBlocks={{
          def1: {
            state: 'marked_wrong',
            correction_event_id: 'e1',
            replacement_artifact_id: null,
          },
        }}
      />,
    );

    expect(html).toContain('定义');
    expect(html).toContain('教材');
    expect(html).toContain('<strong>概念</strong>');
    expect(html).toContain('已标错');
    expect(html).toContain('为什么？');
  });
});
