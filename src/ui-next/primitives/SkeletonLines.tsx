import './blocks.css';
/** Loading placeholder shaped like the content it stands for (M14). */
export function SkeletonLines({ rows = 2, label }: { rows?: number; label: string }) {
  return (
    <div className="un-skeleton" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows.
        <span key={index} className="un-skeleton-line" />
      ))}
    </div>
  );
}
