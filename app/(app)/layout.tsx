'use client';

// Loom app shell — sidebar-primary chrome. Ported from the App() shell of
// docs/design/loom-prototype/app.jsx (sidebar + topbar + mobile tabbar + drawer
// + scrim), mapped onto the Next App Router. Replaces the prior TopNav + TabBar
// chrome. The .app / .sidebar / .topbar / .main / .scrim / .mobile-tabbar class
// layer already lives in app/globals.css.
//
// Preserved from the prior layout: the TokenGate wrapper. Theme reuses the
// existing `data-theme` attribute + localStorage 'loom-theme' key (no second
// key) that app/layout.tsx's THEME_BOOT and ThemeToggle already manage.
//
// Copilot: reuses the existing self-contained TodayCopilotDrawer (it owns its
// own dwell-driven open state + hidden trigger). The shell's Copilot buttons
// open it by clicking that trigger — no fork of the drawer logic. Admin is its
// own (admin) route group, so the sidebar only links to /admin/runs.

import { TokenGate } from '@/ui/components/TokenGate';
import { AppSidebar } from '@/ui/shell/AppSidebar';
import { AppTopbar } from '@/ui/shell/AppTopbar';
import { MobileTabBar } from '@/ui/shell/MobileTabBar';
import { TodayCopilotDrawer } from '@/ui/today/TodayCopilotDrawer';
import { useCallback, useEffect, useRef, useState } from 'react';

const RAIL_KEY = 'loom-rail';
const THEME_KEY = 'loom-theme';

function readRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function readTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    // Only light/dark drive the shell sun/moon toggle. 'auto' (no attribute)
    // falls back to the light icon; toggling from there lands on dark.
    return window.localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const copilotTriggerRef = useRef<HTMLDivElement | null>(null);
  // Track real user toggles so the persist/apply effects below skip the initial
  // hydration sync. Critical for theme: THEME_BOOT represents 'auto' as a removed
  // data-theme attribute, so re-applying 'light'/'dark' on mount would clobber a
  // system-driven preference.
  const railToggled = useRef(false);
  const themeToggled = useRef(false);

  // Hydrate persisted rail / theme after the no-FOUC boot script has run.
  useEffect(() => {
    setRailCollapsed(readRailCollapsed());
    setTheme(readTheme());
  }, []);

  // Updaters stay pure (StrictMode / concurrent-safe); the persist + apply-DOM
  // side effects are the state's derived consequence in the effects below.
  const toggleRail = useCallback(() => {
    railToggled.current = true;
    setRailCollapsed((prev) => !prev);
  }, []);

  const toggleTheme = useCallback(() => {
    themeToggled.current = true;
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  useEffect(() => {
    if (!railToggled.current) return;
    try {
      window.localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0');
    } catch {
      // storage may be unavailable — UI still updates this session.
    }
  }, [railCollapsed]);

  useEffect(() => {
    if (!themeToggled.current) return;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage may be unavailable — attribute still applied this session.
    }
  }, [theme]);

  const closeMobileNav = useCallback(() => setMobileNav(false), []);
  const openMobileNav = useCallback(() => setMobileNav(true), []);

  // Reuse TodayCopilotDrawer's own open path by clicking its hidden trigger.
  const openCopilot = useCallback(() => {
    const trigger = copilotTriggerRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="copilot-drawer-trigger"]',
    );
    trigger?.click();
  }, []);

  return (
    <TokenGate>
      <div className={`app${railCollapsed ? ' rail-collapsed' : ''}`}>
        {mobileNav && (
          <button
            type="button"
            className="scrim open"
            style={{ zIndex: 25 }}
            onClick={closeMobileNav}
            aria-label="关闭导航"
          />
        )}

        <AppSidebar
          mobileOpen={mobileNav}
          onOpenCopilot={openCopilot}
          theme={theme}
          onToggleTheme={toggleTheme}
          onNavigated={closeMobileNav}
        />

        <div className="main">
          <AppTopbar
            onOpenMobileNav={openMobileNav}
            onToggleRail={toggleRail}
            railCollapsed={railCollapsed}
            onOpenCopilot={openCopilot}
          />
          <main>{children}</main>
        </div>

        <MobileTabBar onOpenMobileNav={openMobileNav} />

        {/* Self-contained Copilot drawer. Its visible trigger is hidden — the
            shell's sidebar/topbar Copilot buttons drive it via openCopilot. */}
        <div ref={copilotTriggerRef} className="shell-copilot-mount">
          <TodayCopilotDrawer />
        </div>
      </div>
    </TokenGate>
  );
}
