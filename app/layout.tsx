import { Providers } from '@/ui/Providers';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom — 个人学习工具',
  description: 'A personal learning tool focused on classical Chinese (文言文)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      {/* zh-Hans for CJK Simplified — Biome only accepts ISO 639-1 */}
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
