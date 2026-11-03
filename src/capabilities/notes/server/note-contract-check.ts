// Deterministic body-block contract check for generated notes. Produces typed
// issues only — never a verdict — so findings can ride back to the same
// generation round or persist as the note's known issues.

import type { z } from 'zod';
import { bodyBlocksHaveSemanticKinds } from '@/capabilities/notes/server/body-blocks';
import { NoteKnownIssues, type NoteVerificationIssueT } from '@/core/schema/business';

const ATOMIC_REQUIRED_SEMANTIC_KINDS = [
  'definition',
  'mechanism',
  'example',
  'pitfall',
  'check',
] as const;

export function noteBodyContractIssues(
  artifactType: string,
  bodyBlocks: unknown,
): NoteVerificationIssueT[] {
  if (artifactType !== 'note_atomic') return [];
  const semanticCheck = bodyBlocksHaveSemanticKinds(bodyBlocks, [
    ...ATOMIC_REQUIRED_SEMANTIC_KINDS,
  ]);
  if (semanticCheck.ok) return [];
  const missingKinds = semanticCheck.missing.join(', ');
  return [
    {
      block_id: null,
      severity: 'error',
      category: 'coverage',
      message: `Missing semantic_kind blocks: ${missingKinds}.`,
      suggested_fix_md:
        'Regenerate or edit body_blocks so definition, mechanism, example, pitfall, and check each appear at least once.',
    },
  ];
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
