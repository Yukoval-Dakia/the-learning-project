import type { ReactNode, Ref } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { holdReadingPosition } from '../motion/reading';

export interface AppFrameProps {
  /** Sidebar content; which entries it lists is pending-layer (N1). */
  sidebar: ReactNode;
  sidebarCollapsed: boolean;
  /** The 48px bar inside the frame: breadcrumbs, page action, panel toggle (N2). */
  topbar: ReactNode;
  /** The learning companion panel (C1); rendered beside the content, never over it. */
  companion?: ReactNode;
  companionOpen: boolean;
  /** Phone bottom chrome (tab bar, sheet); only shown at phone width. */
  phoneChrome?: ReactNode;
  scrollRef?: Ref<HTMLElement>;
  children: ReactNode;
}

/**
 * The shell: a collapsible sidebar plus an inset frame holding the top bar, the reading column
 * and the companion panel (N2, C1). When the panel or the sidebar changes width, the paragraph
 * under the reader's eyes is held in place (M7).
 */
export function AppFrame({
  sidebar,
  sidebarCollapsed,
  topbar,
  companion,
  companionOpen,
  phoneChrome,
  scrollRef,
  children,
}: AppFrameProps) {
  const ownScroll = useRef<HTMLElement | null>(null);
  const layout = useRef({ companionOpen, sidebarCollapsed });

  useLayoutEffect(() => {
    const before = layout.current;
    layout.current = { companionOpen, sidebarCollapsed };
    if (before.companionOpen === companionOpen && before.sidebarCollapsed === sidebarCollapsed) {
      return;
    }
    return holdReadingPosition(ownScroll.current);
  }, [companionOpen, sidebarCollapsed]);

  const setScroll = (el: HTMLElement | null) => {
    ownScroll.current = el;
    if (typeof scrollRef === 'function') scrollRef(el);
    else if (scrollRef) scrollRef.current = el;
  };

  return (
    <div
      className="un-app"
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'open'}
      data-companion={companionOpen ? 'open' : 'closed'}
    >
      <div className="un-app-sidebar">{sidebar}</div>
      <div className="un-app-frame">
        <header className="un-app-topbar">{topbar}</header>
        <div className="un-app-body">
          <main ref={setScroll} className="un-app-scroll">
            {children}
          </main>
          {companion}
        </div>
      </div>
      {phoneChrome && <div className="un-app-phone-chrome">{phoneChrome}</div>}
    </div>
  );
}
