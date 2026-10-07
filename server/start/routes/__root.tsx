import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

// P1 serves the original SPA document. This document is for future migrated routes.
export const Route = createRootRoute({
  component: () => (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
