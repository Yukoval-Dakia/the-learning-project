// M0 (YUK-313) — SPA 入口：TokenGate + TanStack Router + TanStack Query。
// M5-T5c (YUK-321)：globals.css 已随 app/ 拆除迁入 web/src/。
import './globals.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenGate } from './TokenGate';
import { router } from './router';

const queryClient = new QueryClient();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TokenGate>
        <RouterProvider router={router} />
      </TokenGate>
    </QueryClientProvider>
  </StrictMode>,
);
