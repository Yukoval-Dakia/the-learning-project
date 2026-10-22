import { createFileRoute } from '@tanstack/react-router';

// YUK-1473 — drafts are the 「待审核」 view of 题目. Old links and bookmarks to /drafts land there;
// /questions is served by the app fallback, so this is a plain document redirect.
const DRAFTS_VIEW = '/questions?status=draft';

export const Route = createFileRoute('/drafts')({
  server: {
    handlers: {
      GET: ({ request }) => Response.redirect(new URL(DRAFTS_VIEW, request.url), 302),
    },
  },
});
