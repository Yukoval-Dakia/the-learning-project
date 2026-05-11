import { type NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest): NextResponse | undefined {
  const path = req.nextUrl.pathname;
  // Uptime monitors hit /api/health without credentials; explicitly exempt.
  if (path === '/api/health') return;
  const token = req.headers.get('x-internal-token');
  if (!token || token !== process.env.INTERNAL_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

export const config = { matcher: '/api/:path*' };
