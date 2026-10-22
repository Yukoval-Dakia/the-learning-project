import './blocks.css';
/** An area that failed to load: says so plainly and offers a retry; the rest of the page stays (M14). */
export function RetryLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="un-retry" role="alert">
      <span>{message}</span>
      <button type="button" className="un-retry-btn un-hit" onClick={onRetry}>
        重试
      </button>
    </p>
  );
}
