// ErrorState — inline error block with retry. className-driven over the .errorstate
// class layer in app/globals.css. Ported from docs/design/loom-prototype/
// components.jsx (ErrorState).

import { Btn } from './Btn';
import { LoomIcon } from './LoomIcon';

export interface ErrorStateProps {
  text?: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ text = '加载失败。', onRetry, compact }: ErrorStateProps) {
  return (
    <div className={`errorstate${compact ? ' compact' : ''}`} role="alert">
      <span className="errorstate-ic">
        <LoomIcon name="alert" size={compact ? 16 : 20} />
      </span>
      <span className="errorstate-text">{text}</span>
      <Btn size="sm" variant="secondary" icon="refresh" onClick={onRetry}>
        重试
      </Btn>
    </div>
  );
}
