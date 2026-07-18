import { UI_SURFACES } from '@/kernel/ui-surfaces';
import { lazyRouteComponent } from '@tanstack/react-router';
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

    for (const route of pageRoutes) {
      const component = route.options.component;
      await component?.preload?.();
      // lazyRouteComponent deliberately catches preload failures and rethrows them from its
      // render function. Invoke that boundary (without mounting the data-fetching page body)
      // so a missing module or named export cannot pass this gate.
      expect(() => component?.({}), route.id).not.toThrow();
    }
  });

  it('proves the render-boundary assertion catches a preload error', async () => {
    const BrokenRoute = lazyRouteComponent(async (): Promise<{ default: () => null }> => {
      throw new Error('broken route chunk');
    });

    await expect(BrokenRoute.preload?.()).resolves.toBeUndefined();
    expect(() => BrokenRoute({})).toThrow('broken route chunk');
  });

  it('keeps the shared pending state accessible without announcing a fast transition', () => {
    expect(router.options.defaultPendingComponent).toBeTypeOf('function');
    expect(router.options.defaultPendingMs).toBe(300);
    expect(router.options.defaultPendingMinMs).toBe(300);
  });
});
