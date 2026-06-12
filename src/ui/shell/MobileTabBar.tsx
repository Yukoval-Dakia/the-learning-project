'use client';

// MobileTabBar — the loom phone bottom bar (≤5 entries). Ported from the
// <nav className="mobile-tabbar"> block of docs/design/loom-prototype/app.jsx.
// The `__more` entry opens the sidebar drawer instead of navigating. Visible
// only ≤720px via the .mobile-tabbar @media rule in app/globals.css.

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { usePathname, useRouter } from 'next/navigation';
import { MOBILE_NAV, ROUTE_MAP, activeFromPath } from './nav-config';

export interface MobileTabBarProps {
  /** Open the sidebar drawer (triggered by the `__more` tab). */
  onOpenMobileNav: () => void;
}

export function MobileTabBar({ onOpenMobileNav }: MobileTabBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeFromPath(pathname);

  return (
    <nav className="mobile-tabbar" aria-label="主导航">
      {MOBILE_NAV.map((tab) => {
        const isActive = tab.id !== '__more' && active === tab.id;
        return (
          <button
            type="button"
            key={tab.id}
            className={`mtab${isActive ? ' is-active' : ''}`}
            onClick={() =>
              // fallback /mistakes：/today 已迁 SPA，Next 侧无此路由（M4, YUK-319）
              tab.id === '__more' ? onOpenMobileNav() : router.push(ROUTE_MAP[tab.id] ?? '/mistakes')
            }
          >
            <LoomIcon name={tab.icon} size={20} />
            <span className="mtab-l">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
