// Keeps generated material visible to the learner and available to copy-safety verification.
import type { QuizGenQuestionT } from '@/core/schema/quiz_gen';

// YUK-224 F1 (PR #314 round-1) — read-model passthrough, v1 self-contained.
// For a material_grounded question the题干 references a passage the learner can
// only see if it is rendered alongside the prompt. The review / practice
// render only reads prompt_md, so we EMBED the passage into prompt_md at persist
// time as a leading blockquote ("阅读材料") followed by the original prompt. Pure
// function so it is unit-testable.
//
// phase-deferred: the structural fix — a read-model that renders 题面 and 素材
// separately and de-duplicates one passage across many questions (instead of
// inlining a copy per question) — is a follow-up. See YUK-216 spec §6.1 row 3.
// Until that read-model lands, the embedded copy keeps the learner-visible
// material self-contained.
export function embedMaterialInPrompt(promptMd: string, materialBodyMd: string): string {
  const trimmed = materialBodyMd.trim();
  if (trimmed.length === 0) return promptMd;
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `> **阅读材料**\n${quoted}\n\n${promptMd}`;
}

// YUK-224 F3 (PR #314 round-1) — synthesize per-question source_refs from the
// top-level material so the deterministic copy-safety overlap (quiz_verify reads
// meta.source_refs[].snippet) has the actual passage to compare against. A
// material_grounded question that left source_refs empty would lose the overlap
// signal entirely. We do NOT force the agent to re-emit the passage per question;
// the handler folds ONE synthesized ref (the material URL + a snippet截段 of the
// passage) into each question's source_refs, in addition to whatever the agent
// declared. Pure function so it is unit-testable.
const MATERIAL_SNIPPET_MAX = 500;
export function synthesizeMaterialSourceRefs(
  declared: QuizGenQuestionT['source_refs'],
  material: { url: string; title: string; body_md: string },
): QuizGenQuestionT['source_refs'] {
  const snippet = material.body_md.trim().slice(0, MATERIAL_SNIPPET_MAX);
  // Skip if the agent already declared a ref carrying the material URL with a
  // snippet (don't duplicate). Otherwise prepend the synthesized material ref.
  const alreadyHasMaterialSnippet = declared.some(
    (r) => r.url === material.url && typeof r.snippet === 'string' && r.snippet.length > 0,
  );
  if (alreadyHasMaterialSnippet) return declared;
  return [
    {
      url: material.url,
      title: material.title,
      snippet,
      used_for: 'fact' as const,
      extracted: true,
    },
    ...declared,
  ];
}
