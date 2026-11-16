// Deterministic body-block contract check for generated notes. Produces typed
// issues only — never a verdict — so findings can ride back to the same
// generation round or persist as the note's known issues.

import type { z } from 'zod';
import { bodyBlocksHaveSemanticKinds } from '@/capabilities/notes/server/body-blocks';
import {
  ArtifactBodyBlocks,
  NoteKnownIssues,
  type NoteVerificationIssueT,
} from '@/core/schema/business';

const ATOMIC_REQUIRED_SEMANTIC_KINDS = [
  'definition',
  'mechanism',
  'example',
  'pitfall',
  'check',
] as const;

// Closing pleasantries the model tends to append. Detection only — the line is
// never removed here; the issue goes back to the model, which owns the text.
const CLOSING_PLEASANTRY_PHRASES = [
  '以上就是这篇',
  '以上就是本篇',
  '希望对你有帮助',
  '希望对你有用',
  '希望这对你',
  '如有问题',
  '如有疑问',
  '欢迎继续提问',
  '祝你学习',
  '祝学习进步',
];

function isClosingPleasantry(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (trimmed.includes('$') || trimmed.includes('\\')) return false;
  return CLOSING_PLEASANTRY_PHRASES.some((phrase) => trimmed.includes(phrase));
}

function paragraphLines(node: Record<string, unknown>): string[] {
  const lines: string[] = [];
  let current = '';
  const walk = (child: Record<string, unknown>) => {
    if (child.type === 'hardBreak') {
      lines.push(current);
      current = '';
    }
    if (typeof child.text === 'string') current += child.text;
    const nested = Array.isArray(child.content) ? child.content : [];
    for (const entry of nested) {
      if (entry !== null && typeof entry === 'object') walk(entry as Record<string, unknown>);
    }
  };
  walk(node);
  lines.push(current);
  return lines;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The note's final paragraph — for atomic notes, the last block of its last section. */
function trailingParagraph(
  bodyBlocks: unknown,
): { blockId: string | null; lastLine: string } | null {
  const parsed = ArtifactBodyBlocks.safeParse(bodyBlocks);
  if (!parsed.success) return null;
  let node = parsed.data.content[parsed.data.content.length - 1] as
    | Record<string, unknown>
    | undefined;
  while (node && node.type === 'semanticBlock') {
    const content = Array.isArray(node.content) ? node.content : [];
    node = content[content.length - 1] as Record<string, unknown> | undefined;
  }
  if (node?.type !== 'paragraph') return null;
  const lastLine = paragraphLines(node)
    .reverse()
    .find((line) => line.trim().length > 0);
  if (lastLine === undefined || !isClosingPleasantry(lastLine)) return null;
  const id = recordOrEmpty(node.attrs).id;
  return { blockId: typeof id === 'string' ? id : null, lastLine: lastLine.trim() };
}

export function noteBodyContractIssues(
  artifactType: string,
  bodyBlocks: unknown,
): NoteVerificationIssueT[] {
  const issues: NoteVerificationIssueT[] = [];
  if (artifactType === 'note_atomic') {
    const semanticCheck = bodyBlocksHaveSemanticKinds(bodyBlocks, [
      ...ATOMIC_REQUIRED_SEMANTIC_KINDS,
    ]);
    if (!semanticCheck.ok) {
      const missingKinds = semanticCheck.missing.join(', ');
      issues.push({
        block_id: null,
        severity: 'error',
        category: 'coverage',
        message: `Missing semantic_kind blocks: ${missingKinds}.`,
        suggested_fix_md:
          'Regenerate or edit body_blocks so definition, mechanism, example, pitfall, and check each appear at least once.',
      });
    }
  }
  const trailing = trailingParagraph(bodyBlocks);
  if (trailing) {
    issues.push({
      block_id: trailing.blockId,
      severity: 'warn',
      category: 'format',
      message: `The note ends with a closing pleasantry: "${trailing.lastLine}".`,
      suggested_fix_md:
        'Remove the closing pleasantry so the note ends on its last content block; do not replace it with a summary or new closing line.',
    });
  }
  return issues;
}

export type NoteKnownIssuesT = z.infer<typeof NoteKnownIssues>;

/** Wrap unresolved issues as the note's known-issues payload; null when clean. */
export function noteKnownIssuesSummary(issues: NoteVerificationIssueT[]): NoteKnownIssuesT | null {
  if (issues.length === 0) return null;
  return NoteKnownIssues.parse({
    kind: 'known_issues',
    summary_md: `Deterministic contract check flagged ${issues.length} unresolved issue(s).`,
    issues,
  });
}
