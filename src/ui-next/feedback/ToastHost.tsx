import { X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { IconButton } from '../primitives/IconButton';
import { UiNextRoot } from '../shell/Root';
import { dismissToast, readServerToasts, readToasts, subscribeToasts } from './toast-store';
import './toast.css';

/**
 * Shows the toasts from toast-store (M15): glass, bottom right, at most three, above the phone
 * tab bar. The old app shell has no toast host, so each ui-next page that shows toasts renders
 * one; the store is module-wide, so a toast raised on one page (删除 → 撤销) survives navigation.
 */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, readToasts, readServerToasts);
  // The live region stays mounted even when empty, so screen readers announce the first toast.
  return (
    <UiNextRoot className="un-toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="un-toast un-glass" role="status">
          <span className="un-toast-text">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="un-toast-action un-hit"
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <IconButton
            label="关闭提示"
            icon={<X size={14} />}
            onClick={() => dismissToast(toast.id)}
          />
        </div>
      ))}
    </UiNextRoot>
  );
}
