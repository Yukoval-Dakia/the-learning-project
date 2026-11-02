import type { ComponentType } from 'react';
import type { GroupEvidenceT, ResponseSetT } from '@/core/schema/assessment';
import { ConfirmationOccurrence, type ConfirmationOccurrenceT } from '../confirmation-contract';

export interface ConfirmationProjection {
  occurrence: ConfirmationOccurrenceT;
  assessment: unknown;
}
export interface ConfirmationAssessmentProps {
  occurrenceId: string;
  sessionId: string;
  assessment: unknown;
  disabled: boolean;
  onSubmit(response: ResponseSetT, evidence: GroupEvidenceT[]): Promise<void>;
  onRefresh(): void;
}
export type ConfirmationAssessmentRenderer = ComponentType<ConfirmationAssessmentProps>;

export function parseConfirmation(value: unknown): ConfirmationProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const occurrence = ConfirmationOccurrence.safeParse(row.occurrence);
  if (!occurrence.success || !('assessment' in row)) return undefined;
  return { occurrence: occurrence.data, assessment: row.assessment };
}
