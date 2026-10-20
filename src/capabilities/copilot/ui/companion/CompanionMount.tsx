// The shell's one companion instance. Always mounted (closed it renders nothing visible): it restores
// unconfirmed sends from the browser once, claims open requests published by pages, polls nudges
// for the shell's badge, and shows the panel while `open`. Unmounting only detaches streams.

import { useCallback } from 'react';
import { subscribeCopilotOpenRequests } from '@/ui/lib/use-copilot-dwell';
import { useCopilotNudges } from '../useCopilotNudges';
import { type CompanionLayout, CompanionPanel } from './CompanionPanel';
import { useCompanionController, useTurnPolling } from './use-companion';

export interface CompanionMountProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layout: CompanionLayout;
  /**
   * A conversation to show (e.g. picked from the shell's 最近 list). Treated as a request: it is
   * applied when the panel opens or when the value changes; clear it when the panel closes.
   */
  sessionId?: string | null;
  navigate: (to: string) => void;
}

export function CompanionMount({
  open,
  onOpenChange,
  layout,
  sessionId,
  navigate,
}: CompanionMountProps) {
  const controller = useCompanionController();
  const nudges = useCopilotNudges();
  useTurnPolling(controller);

  const attachLifetime = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return undefined;
      controller.sender.initializeFromStorage();
      // Leaving the page never cancels: it only stops reading the streams.
      return () => controller.runs.detachSubscriptions(undefined, false);
    },
    [controller],
  );
  const attachOpenRequests = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return undefined;
      return subscribeCopilotOpenRequests((request) =>
        controller.sender.handleOpenRequest(request, () => onOpenChange(true)),
      );
    },
    [controller, onOpenChange],
  );
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <div ref={attachLifetime} className="un-cp-mount" style={{ display: 'contents' }}>
      <span ref={attachOpenRequests} hidden />
      {open ? (
        <CompanionPanel
          controller={controller}
          layout={layout}
          onClose={close}
          navigate={navigate}
          nudges={nudges}
          sessionId={sessionId}
        />
      ) : null}
    </div>
  );
}
