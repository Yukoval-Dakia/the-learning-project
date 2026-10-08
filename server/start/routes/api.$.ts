import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/$')({
  server: { handlers: { ANY: ({ request, context }) => context.api.fetch(request) } },
});
