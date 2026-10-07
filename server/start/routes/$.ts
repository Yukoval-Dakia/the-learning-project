import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/$')({
  server: { handlers: { ANY: ({ request, context }) => context.legacySpa.fetch(request) } },
});
