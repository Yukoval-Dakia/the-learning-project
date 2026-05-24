export interface ReviewSubjectMarkerSubject {
  id: string;
  displayName: string;
}

export function shouldShowSubjectSwitchMarker(
  from: ReviewSubjectMarkerSubject | null | undefined,
  to: ReviewSubjectMarkerSubject | null | undefined,
) {
  return Boolean(from && to && from.id !== to.id);
}

export function ReviewSubjectSwitchMarker({
  from,
  to,
}: {
  from: ReviewSubjectMarkerSubject | null | undefined;
  to: ReviewSubjectMarkerSubject;
}) {
  if (!shouldShowSubjectSwitchMarker(from, to)) return null;

  const title = `下一题：${to.displayName}`;
  const description = `从 ${from?.displayName} 切换到 ${to.displayName}`;

  return (
    <div className="review-subject-switch" data-subject={to.id}>
      <span className="review-subject-switch__eyebrow">subject switch</span>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}
