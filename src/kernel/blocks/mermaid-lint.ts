// YUK-1548 (§3.1) — server lint over mermaid source, beyond mermaid.parse.
// The parser itself accepts `click`, `%%{init}` and raw HTML labels, so every
// interactive/HTML-bearing construct is rejected here with typed issues.

import type { BlockIssueT } from '@/core/schema/blocks';

export const MERMAID_ALLOWED_TYPES = [
  'flowchart',
  'graph',
  'sequenceDiagram',
  'stateDiagram-v2',
  'classDiagram',
  'mindmap',
  'timeline',
  'erDiagram',
] as const;

const ALLOWED_TYPE_LABEL = [...MERMAID_ALLOWED_TYPES];

function issue(partial: Omit<BlockIssueT, 'path'>): BlockIssueT {
  return { path: '/source', ...partial };
}

/** First meaningful token decides the diagram type. */
function diagramTypeOf(source: string): string | undefined {
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('%%')) continue;
    const [first] = line.split(/[\s{]/);
    return first;
  }
  return undefined;
}

/** Deterministic forbidden-construct scan; one issue per violated rule. */
export function lintMermaidSource(source: string): BlockIssueT[] {
  const issues: BlockIssueT[] = [];
  const lines = source.split('\n');

  const type = diagramTypeOf(source);
  if (
    type !== undefined &&
    !MERMAID_ALLOWED_TYPES.includes(type as (typeof MERMAID_ALLOWED_TYPES)[number])
  ) {
    issues.push(
      issue({
        code: 'diagram_type_unsupported',
        detail: `diagram type '${type}' is not supported; use one of the allowlisted types`,
        expected: ALLOWED_TYPE_LABEL,
      }),
    );
  }

  lines.forEach((raw, index) => {
    const line = raw;
    const at = index + 1;
    if (line.includes('%%{')) {
      issues.push(
        issue({
          code: 'diagram_directive_forbidden',
          detail: '%%{…} init/directive statements are not allowed',
          line: at,
          column: line.indexOf('%%{') + 1,
        }),
      );
    }
    const interactive = line.match(/\b(click|href|callback)\b/);
    if (interactive) {
      issues.push(
        issue({
          code: 'diagram_directive_forbidden',
          detail: `'${interactive[1]}' statements are not allowed; blocks never wire links or callbacks`,
          line: at,
          column: interactive.index !== undefined ? interactive.index + 1 : undefined,
        }),
      );
    }
    if (/\b(style|classDef)\b[^\n]*url\(/i.test(line)) {
      issues.push(
        issue({
          code: 'diagram_directive_forbidden',
          detail: 'url() inside style/classDef is not allowed',
          line: at,
          column: line.search(/url\(/i) + 1,
        }),
      );
    }
    const angle = line.indexOf('<');
    if (angle !== -1 && !line.trimStart().startsWith('%%')) {
      issues.push(
        issue({
          code: 'diagram_directive_forbidden',
          detail: "raw '<' is not allowed in labels; write text or use the #lt; entity",
          line: at,
          column: angle + 1,
        }),
      );
    }
  });
  return issues;
}
