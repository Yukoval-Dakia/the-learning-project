// The Vite-generated fetch entry is external to the Node transport CJS build.
declare module '*dist/start/server/server.js' {
  import type { Register } from '@tanstack/react-router';
  import type { RequestHandler } from '@tanstack/react-start/server';

  const entry: { fetch: RequestHandler<Register> };
  export default entry;
}
