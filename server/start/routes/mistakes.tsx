import { createFileRoute } from '@tanstack/react-router';

// YUK-1473 — 错题 is the 「做错过」 view of 题目. Old links and bookmarks to /mistakes land there;
// /questions is served by the app fallback, so this is a plain document redirect.
const MISTAKES_VIEW = '/questions?view=mistakes';

export const Route = createFileRoute('/mistakes')({
  server: {
    handlers: {
      GET: ({ request }) => Response.redirect(new URL(MISTAKES_VIEW, request.url), 302),
    },
  },
});
