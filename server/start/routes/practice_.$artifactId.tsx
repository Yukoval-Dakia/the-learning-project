import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/practice_/$artifactId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      href: `/practice?${new URLSearchParams({ paper: params.artifactId })}`,
      replace: true,
    });
  },
});
