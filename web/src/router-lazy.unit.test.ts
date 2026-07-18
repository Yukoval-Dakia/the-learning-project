import { UI_SURFACES } from '@/kernel/ui-surfaces';
import { describe, expect, it } from 'vitest';
import { router } from './router';

describe('SPA route chunk policy', () => {
  it('gives every shipped page a working preloadable lazy route component', async () => {
    const pageRoutes = Object.values(router.routesById).filter(
      (route) => !route.isRoot && route.options.component !== undefined,
    );
    const shippedPageCount = UI_SURFACES.filter((surface) => surface.kind === 'page').length;

    expect(pageRoutes).toHaveLength(shippedPageCount);
    for (const route of pageRoutes) {
      expect(route.options.component, route.id).toHaveProperty('preload');
      expect(typeof route.options.component?.preload, route.id).toBe('function');
    }

    await Promise.all(pageRoutes.map((route) => route.options.component?.preload?.()));
  });

  it('keeps the shared pending state accessible without announcing a fast transition', () => {
    expect(router.options.defaultPendingComponent).toBeTypeOf('function');
    expect(router.options.defaultPendingMs).toBe(300);
    expect(router.options.defaultPendingMinMs).toBe(300);
  });
});
