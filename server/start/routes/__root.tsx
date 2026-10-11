import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

// Migrated routes use this document; unrelated routes keep the P7-owned SPA fallback.
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 'Loom' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
    ],
  }),
  component: () => (
    <html lang="zh-CN">
      <head>
        <HeadContent />
        <meta name="theme-color" content="#faf9f5" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1a1612" media="(prefers-color-scheme: dark)" />
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
