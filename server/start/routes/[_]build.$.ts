import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_build/$')({
  server: { handlers: { ANY: ({ request, context }) => context.startAssets.fetch(request) } },
});
