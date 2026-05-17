import { Providers } from '@/ui/Providers';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom — 个人学习工具',
  description: 'A personal learning tool focused on classical Chinese (文言文)',
};

// No-FOUC theme boot: synchronously read localStorage *before* React hydrates
// and apply `data-theme` to <html>. Inlined into <head> via `dangerouslySet…`
// because it MUST run before first paint — defer/module attrs would let the
// page flash light tokens before the dark attribute lands.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('loom-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      {/* zh-Hans for CJK Simplified — Biome only accepts ISO 639-1 */}
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: needed to land
            data-theme before hydration; see THEME_BOOT comment above. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
