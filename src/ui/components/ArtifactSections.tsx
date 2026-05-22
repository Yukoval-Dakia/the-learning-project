'use client';

import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  type SlimSubjectProfile,
  resolveSubjectRenderModel,
  subjectContentProps,
} from '@/ui/lib/subject';
import { type EmbeddedCheckQuestion, EmbeddedCheckSection } from './EmbeddedCheckSection';

export type { EmbeddedCheckQuestion };

export type ArtifactSectionKind = 'definition' | 'mechanism' | 'example' | 'pitfall' | 'check';
export type ArtifactSourceTier = 'llm_only' | 'search_grounded' | 'textbook' | 'user_verified';
export type ArtifactEmbeddedCheckStatus = 'not_required' | 'pending' | 'ready' | 'failed';

export interface ArtifactSection {
  id: string;
  kind: ArtifactSectionKind;
  body_md: string;
  source_tier: ArtifactSourceTier;
  user_verified: boolean;
  embedded_check: { question_ids: string[] } | null;
  version: number;
}

const SECTION_LABEL: Record<ArtifactSectionKind, string> = {
  definition: '定义',
  mechanism: '机制 / 规则',
  example: '例',
  pitfall: '易错',
  check: '自检',
};

const SOURCE_TIER_LABEL: Record<ArtifactSourceTier, string> = {
  llm_only: 'AI 单 pass',
  search_grounded: 'search-grounded',
  textbook: '教材',
  user_verified: '已核',
};

interface ArtifactSectionsProps {
  sections: ArtifactSection[];
  subjectProfile: SlimSubjectProfile;
  embeddedQuestions: EmbeddedCheckQuestion[];
  embeddedCheckStatus: ArtifactEmbeddedCheckStatus;
}

export function ArtifactSections({
  sections,
  subjectProfile,
  embeddedQuestions,
  embeddedCheckStatus,
}: ArtifactSectionsProps) {
  const subjectModel = resolveSubjectRenderModel(subjectProfile);
  return (
    <div className="artifact-sections">
      {sections.map((s) => {
        const sectionBodyProps = subjectContentProps(subjectModel, {
          className: 'artifact-section-body',
        });
        return (
          <div key={s.id} className="artifact-section">
            <div className="artifact-section-head">
              <strong>{SECTION_LABEL[s.kind]}</strong>
              <span className="artifact-section-tier">{SOURCE_TIER_LABEL[s.source_tier]}</span>
            </div>
            <MathMarkdown
              notation={
                (subjectModel.renderConfig.notation ?? undefined) as
                  | 'latex'
                  | 'wenyan'
                  | 'plaintext'
                  | 'code'
                  | undefined
              }
              {...sectionBodyProps}
            >
              {s.body_md}
            </MathMarkdown>
            {s.kind === 'check' && (
              <EmbeddedCheckSection
                status={embeddedCheckStatus}
                questions={embeddedQuestions}
                notation={
                  (subjectModel.renderConfig.notation ?? undefined) as
                    | 'latex'
                    | 'wenyan'
                    | 'plaintext'
                    | 'code'
                    | undefined
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
