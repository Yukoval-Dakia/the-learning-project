import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capabilities } from '@/capabilities';
import { UI_SURFACES, auditUiSurfaceInventory } from '@/kernel/ui-surfaces';
import {
  COMMAND_PALETTE_PLACEHOLDER,
  NAV,
  SEARCH_PAGE_ITEMS,
  activeFromPath,
  isSection,
  titleFromPath,
} from '@/ui/shell/nav-config';
import { describe, expect, it } from 'vitest';

const routerSource = readFileSync(join(process.cwd(), 'web/src/router.tsx'), 'utf8');
const routerSurfaceIds = [...routerSource.matchAll(/path:\s*surfacePath\('([^']+)'\)/g)].map(
  (match) => match[1] ?? '',
);
const manifestPages = capabilities.flatMap((capability) =>
  (capability.ui?.pages ?? []).map((page) => ({ owner: capability.name, route: page.route })),
);

describe('shipped UI surface inventory', () => {
  it('bidirectionally reconciles router bindings and capability manifests', () => {
    expect(routerSource).not.toMatch(/path:\s*['"]\//);
    expect(() => auditUiSurfaceInventory({ routerSurfaceIds, manifestPages })).not.toThrow();
  });

  it('fails when a route binding is missing or ghosted', () => {
    expect(() =>
      auditUiSurfaceInventory({ routerSurfaceIds: routerSurfaceIds.slice(1), manifestPages }),
    ).toThrow(/inventory route is not bound in router/);
    expect(() =>
      auditUiSurfaceInventory({
        routerSurfaceIds: [...routerSurfaceIds, 'ghost-route'],
        manifestPages,
      }),
    ).toThrow(/router binds unknown surface: ghost-route/);
  });

  it('fails on a missing, ghost, or colon-style manifest declaration', () => {
    const withoutMistakes = manifestPages.filter((page) => page.route !== '/mistakes');
    expect(() =>
      auditUiSurfaceInventory({ routerSurfaceIds, manifestPages: withoutMistakes }),
    ).toThrow(/manifest is missing page: practice \/mistakes/);

    const withGhost = [...manifestPages, { owner: 'shell', route: '/ghost' }];
    expect(() => auditUiSurfaceInventory({ routerSurfaceIds, manifestPages: withGhost })).toThrow(
      /manifest declares unknown or misowned page: shell \/ghost/,
    );

    const colonDetail = manifestPages.map((page) =>
      page.route === '/questions/$id' ? { ...page, route: '/questions/:id' } : page,
    );
    expect(() => auditUiSurfaceInventory({ routerSurfaceIds, manifestPages: colonDetail })).toThrow(
      /manifest route must use TanStack \$param syntax: practice \/questions\/:id/,
    );
  });

  it('gives every shipped route an explicit title and never falls back to Today', () => {
    const examples: Array<[string, string, string]> = [
      ['/mistakes', 'mistakes', '错题本'],
      ['/welcome', 'welcome', '开始设置'],
      ['/profile', 'profile', '起始档案'],
      ['/questions/q_1', 'questions', '题目详情'],
      ['/knowledge/k_1', 'knowledge', '知识详情'],
      ['/events/e_1', 'events', '事件证据'],
      ['/admin/cost', 'admin', '成本'],
    ];
    for (const [path, active, title] of examples) {
      expect(activeFromPath(path)).toBe(active);
      expect(titleFromPath(path)).toBe(title);
    }
    expect(activeFromPath('/not-shipped')).toBe('');
    expect(titleFromPath('/not-shipped')).toBe('未知页面');
  });

  it('projects sidebar and command palette from the same inventory', () => {
    const navRoutes = NAV.flatMap((entry) => (isSection(entry) ? [] : [entry.path]));
    const inventoryNavRoutes = UI_SURFACES.filter((surface) => 'nav' in surface && surface.nav).map(
      (surface) => surface.route,
    );
    expect(navRoutes.sort()).toEqual(inventoryNavRoutes.sort());

    const searchRoutes = SEARCH_PAGE_ITEMS.map((item) => item.path);
    expect(searchRoutes).toContain('/questions');
    expect(searchRoutes).toContain('/mistakes');
    expect(searchRoutes.some((route) => route.includes('$'))).toBe(false);
    expect(COMMAND_PALETTE_PLACEHOLDER).toBe('搜索页面和知识节点…');
  });

  it('has removed the unconsumed todayBlocks declaration field', () => {
    for (const capability of capabilities) {
      expect((capability.ui as Record<string, unknown> | undefined)?.todayBlocks).toBeUndefined();
    }
  });

  it('keeps page surfaces lazy while the shared shell remains eager', () => {
    const staticCapabilityUiImports = [
      ...routerSource.matchAll(/from\s+['"](@\/capabilities\/[^'"]+\/ui(?:\/[^'"]*)?)['"]/g),
    ]
      .map((match) => match[1])
      .sort();

    expect(staticCapabilityUiImports).toEqual([
      '@/capabilities/copilot/ui/CopilotDock',
      '@/capabilities/shell/ui/workbench-api',
    ]);
    expect(routerSource).toContain("import('./routes/MistakesPage')");
    expect(routerSource).not.toContain("import('@/capabilities/observability/ui/observability')");
    for (const adminModule of ['admin-runs', 'admin-cost', 'admin-failures']) {
      expect(routerSource).toContain(`import('@/capabilities/observability/ui/${adminModule}')`);
    }
    expect(routerSource).toContain('lazyRouteComponent');
    expect(routerSource).toContain('defaultPendingComponent: RoutePending');
    expect(routerSource).toContain('aria-live="polite"');
  });
});
