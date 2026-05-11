import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Loom — 个人学习工具',
  description: 'A personal learning tool focused on classical Chinese (文言文)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
