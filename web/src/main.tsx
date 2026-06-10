// M0 (YUK-313) — SPA 入口：TokenGate + TanStack Router + TanStack Query。
// 样式直接 import 旧 app/globals.css（单一真相源；归属在 M5 拆除时迁移）。
import '../../app/globals.css';

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
