// Deterministic body-block contract check for generated notes. Produces typed
// issues only — never a verdict — so findings can ride back to the same
// generation round or persist as the note's known issues.

import type { z } from 'zod';
import {
  bodyBlocksHaveSemanticKinds,
  noteClosingLine,
} from '@/capabilities/notes/server/body-blocks';
import { NoteKnownIssues, type NoteVerificationIssueT } from '@/core/schema/business';

const ATOMIC_REQUIRED_SEMANTIC_KINDS = [
  'definition',
  'mechanism',
  'example',
  'pitfall',
  'check',
] as const;

// Closing pleasantries are reported, never silently trimmed: the note keeps what
// the model wrote and the issue rides back for a same-round revision.
const CLOSING_CHATTER = [
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
] as const;

function closingChatterIssues(bodyBlocks: unknown): NoteVerificationIssueT[] {
  const line = noteClosingLine(bodyBlocks);
  // A short prose sign-off only: formulas and long paragraphs are note content.
  if (line === null || line.length > 80 || line.includes('$') || line.includes('\\')) return [];
  const phrase = CLOSING_CHATTER.find((candidate) => line.includes(candidate));
  if (phrase === undefined) return [];
  return [
    {
      block_id: null,
      severity: 'warn',
      category: 'format',
      message: `The note ends with a closing pleasantry ("${phrase}") instead of its last substantive point.`,
      suggested_fix_md:
        'Drop the closing line and end the last section on the final knowledge point; no well-wishing or invitation to ask questions.',
    },
  ];
}

export function noteBodyContractIssues(
  artifactType: string,
  bodyBlocks: unknown,
): NoteVerificationIssueT[] {
  const issues = closingChatterIssues(bodyBlocks);
  if (artifactType !== 'note_atomic') return issues;
  const semanticCheck = bodyBlocksHaveSemanticKinds(bodyBlocks, [
    ...ATOMIC_REQUIRED_SEMANTIC_KINDS,
  ]);
  if (semanticCheck.ok) return issues;
  const missingKinds = semanticCheck.missing.join(', ');
  issues.push({
    block_id: null,
    severity: 'error',
    category: 'coverage',
    message: `Missing semantic_kind blocks: ${missingKinds}.`,
    suggested_fix_md:
      'Regenerate or edit body_blocks so definition, mechanism, example, pitfall, and check each appear at least once.',
  });
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
