import { mathProfile } from './math/profile';
import { wenyanProfile } from './wenyan/profile';

export type SubjectId = 'wenyan' | 'math';

export type SubjectQuestionKind =
  | 'short_answer'
  | 'multiple_choice'
  | 'reading'
  | 'translation'
  | 'calculation'
  | 'proof'
  | 'concept_explain'
  | 'word_problem';

export type JudgeRouteKind =
  | 'exact_keyword'
  | 'llm_rubric'
  | 'symbolic_math'
  | 'unit_dimension'
  | 'code_execution'
  | 'speech_audio'
  | 'diagram_handwriting'
  | 'human_review';

export interface SubjectProfile {
  id: SubjectId;
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
}

export const subjectProfiles: Record<SubjectId, SubjectProfile> = {
  wenyan: wenyanProfile,
  math: mathProfile,
};

export const defaultSubjectProfile = wenyanProfile;

const DOMAIN_ALIASES: Record<string, SubjectId> = {
  wenyan: 'wenyan',
  classical_chinese: 'wenyan',
  chinese_classics: 'wenyan',
  math: 'math',
  mathematics: 'math',
  maths: 'math',
};

export function resolveSubjectProfile(domain?: string | null): SubjectProfile {
  const key = domain?.trim().toLowerCase();
  if (!key) return defaultSubjectProfile;
  const id = DOMAIN_ALIASES[key];
  return id ? subjectProfiles[id] : defaultSubjectProfile;
}
