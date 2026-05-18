import type {
  CauseCategoryDeclarationT,
  RenderConfigT,
  SchedulingHintsT,
} from '@/core/schema/profile-decl';
import { mathProfile } from './math/profile';
import { wenyanProfile } from './wenyan/profile';

export type SubjectId = 'wenyan' | 'math';

export type SubjectQuestionKind =
  | 'single_choice'
  | 'multiple_choice'
  | 'short_answer'
  | 'translation'
  | 'reading_comprehension'
  | 'proof'
  | 'calculation'
  | 'word_problem';

export type JudgeRouteKind =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'multimodal_direct'
  | 'ai_flexible';

export interface SubjectProfile {
  id: SubjectId;
  version: string;
  displayName: string;
  languageStyle: string;
  questionKinds: SubjectQuestionKind[];
  judgePolicy: {
    preferredRoutes: JudgeRouteKind[];
    notes: string[];
  };
  exampleSources: string[];
  noteTemplate: {
    definition: string;
    mechanism: string;
    example: string;
    pitfall: string;
    check: string;
  };
  grounding: {
    requirement: string;
    allowedSources: string[];
    uncertaintyPolicy: string;
  };
  promptFragments: {
    roleNoun: string;
    noteExamplePolicy: string;
    variantExamplePolicy: string;
    teachingStyle: string;
    checkQuestionPolicy: string;
    learningIntentPolicy: string;
  };
  causeCategories: CauseCategoryDeclarationT[];
  renderConfig: RenderConfigT;
  schedulingHints: SchedulingHintsT;
  judgeCapabilities: string[];
}

export const subjectProfiles: Record<SubjectId, SubjectProfile> = {
  wenyan: wenyanProfile,
  math: mathProfile,
};

export const defaultSubjectProfile = subjectProfiles.wenyan;

const SUBJECT_ALIASES: Record<string, SubjectId> = {
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
  wenyan: 'wenyan',
};

export function resolveSubjectProfile(domain?: string | null): SubjectProfile {
  const key = domain?.trim().toLowerCase();
  if (!key) return defaultSubjectProfile;
  return subjectProfiles[SUBJECT_ALIASES[key] ?? 'wenyan'];
}
