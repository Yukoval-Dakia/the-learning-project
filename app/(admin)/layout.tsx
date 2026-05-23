'use client';

import { TokenGate } from '@/ui/components/TokenGate';
import { ThemeToggle } from '@/ui/primitives/ThemeToggle';
import { type NavItem, TopNav } from '@/ui/primitives/TopNav';
import { usePathname, useRouter } from 'next/navigation';

const ADMIN_NAV: NavItem[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'cost', label: 'Cost' },
  { id: 'failures', label: 'Failures' },
];

const ROUTE_MAP: Record<string, string> = {
  today: '/today',
  runs: '/admin/runs',
  cost: '/admin/cost',
  failures: '/admin/failures',
};

function activeFromPath(pathname: string): string {
  if (pathname.startsWith('/admin/cost')) return 'cost';
  if (pathname.startsWith('/admin/failures')) return 'failures';
  return 'runs';
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeFromPath(pathname);

  return (
    <TokenGate>
      <div className="app-shell">
        <div className="app-shell-top-nav">
          <TopNav
            active={active}
            items={ADMIN_NAV}
            version="admin · YUK-41"
            trailing={<ThemeToggle />}
            onNav={(id) => {
              const target = ROUTE_MAP[id];
              if (target) router.push(target);
            }}
          />
        </div>
        <div className="app-shell-content">{children}</div>
      </div>
    </TokenGate>
  );
}
