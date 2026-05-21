import { Providers } from '@/ui/Providers';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom — 个人学习工具',
  description: 'A personal learning tool focused on classical Chinese (文言文)',
};

// No-FOUC theme boot: the reference design is a light paper UI, so the
// product defaults to `light` unless the user explicitly chose `dark` or
// `auto`. This runs before hydration to avoid a system-dark first paint.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('loom-theme');if(t==='dark'){document.documentElement.setAttribute('data-theme','dark');}else if(t==='auto'){document.documentElement.removeAttribute('data-theme');}else{document.documentElement.setAttribute('data-theme','light');}}catch(e){document.documentElement.setAttribute('data-theme','light');}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
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
