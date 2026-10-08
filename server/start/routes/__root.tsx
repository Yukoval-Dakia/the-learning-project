import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

// Migrated routes use this document; unrelated routes keep the P7-owned SPA fallback.
export const Route = createRootRoute({
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
