export type ActivityKind =
  | 'question'
  | 'question_part'
  | 'record'
  | 'recall_prompt'
  | 'practice_log'
  | 'project_milestone'
  | 'open_inquiry';

export interface ActivityRefInput {
  kind: ActivityKind;
  id: string;
}

const ACTIVITY_KINDS = new Set<ActivityKind>([
  'question',
  'question_part',
  'record',
  'recall_prompt',
  'practice_log',
  'project_milestone',
  'open_inquiry',
]);

function activityRefFromEvent(
  event: { subject_kind: string; subject_id: string } | null,
): ActivityRefInput | null {
  if (!event) return null;
  if (!ACTIVITY_KINDS.has(event.subject_kind as ActivityKind)) return null;
  return { kind: event.subject_kind as ActivityKind, id: event.subject_id };
}

export function affectedRefsForCorrection(event: {
  subject_kind: string;
  subject_id: string;
}): ActivityRefInput[] {
  const directRef = activityRefFromEvent(event);
  return directRef ? [directRef] : [];
}
