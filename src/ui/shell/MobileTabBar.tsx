// S13 (YUK-335 批次丙) — SPA 移动底栏（≤5 项）。
//
// 设计源 docs/design/loom-refresh/project/app.jsx 的 <nav className="mobile-tabbar">
// 块。`__more` 项开侧栏 drawer 而非导航。仅 ≤720px 经 .mobile-tabbar @media 规则
// （web/src/globals.css §Mobile bottom tab bar L6547）显示。
//
// 路由耦合只经 prop（pathname / navigate）—— 不 import 路由库。

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { MOBILE_NAV, activeFromPath } from './nav-config';

export interface MobileTabBarProps {
  /** 当前路由 pathname（驱动 is-active）。 */
  pathname: string;
  /** 路由推入。 */
  navigate: (to: string) => void;
  /** 开侧栏 drawer（`__more` 项触发）。 */
  onOpenMobileNav: () => void;
}

export function MobileTabBar({ pathname, navigate, onOpenMobileNav }: MobileTabBarProps) {
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
            onClick={() => (tab.id === '__more' ? onOpenMobileNav() : navigate(tab.path))}
          >
            <LoomIcon name={tab.icon} size={20} />
            <span className="mtab-l">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
