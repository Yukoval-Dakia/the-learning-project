import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { z } from 'zod';

export type SubjectId = string;
export const KNOWN_SUBJECT_IDS = ['wenyan', 'math', 'physics'] as const;
export type KnownSubjectId = (typeof KNOWN_SUBJECT_IDS)[number];

export const SubjectQuestionKindSchema = z.enum([
  'single_choice',
  'multiple_choice',
  'short_answer',
  'translation',
  'reading_comprehension',
  'proof',
  'calculation',
  'word_problem',
]);
export type SubjectQuestionKind = z.infer<typeof SubjectQuestionKindSchema>;

// Desired route families for subject policy. These are allowed to mention
// future strategies; judgeCapabilities below lists registry-backed runners.
export const JudgeRouteKindSchema = z.enum([
  'exact',
  'keyword',
  'semantic',
  'rubric',
  'steps',
  'unit_dimension',
  'multimodal_direct',
  'ai_flexible',
]);
export type JudgeRouteKind = z.infer<typeof JudgeRouteKindSchema>;

export const SubjectProfileSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  languageStyle: z.string().trim().min(1),
  questionKinds: z.array(SubjectQuestionKindSchema).min(1),
  judgePolicy: z.object({
    preferredRoutes: z.array(JudgeRouteKindSchema).min(1),
    notes: z.array(z.string()),
  }),
  exampleSources: z.array(z.string().trim().min(1)),
  noteTemplate: z.object({
    definition: z.string().trim().min(1),
    mechanism: z.string().trim().min(1),
    example: z.string().trim().min(1),
    pitfall: z.string().trim().min(1),
    check: z.string().trim().min(1),
  }),
  grounding: z.object({
    requirement: z.string().trim().min(1),
    allowedSources: z.array(z.string().trim().min(1)),
    uncertaintyPolicy: z.string().trim().min(1),
  }),
  promptFragments: z.object({
    roleNoun: z.string().trim().min(1),
    noteExamplePolicy: z.string().trim().min(1),
    variantExamplePolicy: z.string().trim().min(1),
    teachingStyle: z.string().trim().min(1),
    checkQuestionPolicy: z.string().trim().min(1),
    learningIntentPolicy: z.string().trim().min(1),
  }),
  causeCategories: z.array(CauseCategoryDeclaration).min(1),
  renderConfig: RenderConfig,
  schedulingHints: SchedulingHints,
  judgeCapabilities: z.array(z.string().trim().min(1)),
});
export type SubjectProfile = z.infer<typeof SubjectProfileSchema>;
export type SlimSubjectProfile = Pick<SubjectProfile, 'id' | 'displayName' | 'renderConfig'>;
