import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

// Migrated routes use this document; unrelated routes keep the P7-owned SPA fallback.
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
    ],
  }),
  component: () => (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="root">
          <Outlet />
        </div>
        <Scripts />
      </body>
    </html>
  ),
});
