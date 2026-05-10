import { Link } from 'react-router-dom';

interface EntryCard {
  to: string;
  emoji: string;
  title: string;
  subtitle: string;
  primary?: boolean;
}

const ENTRIES: EntryCard[] = [
  {
    to: '/capture',
    emoji: '📷',
    title: '录题',
    subtitle: '上传图片，OCR + AI 兜底',
    primary: true,
  },
  { to: '/review', emoji: '📚', title: '复习', subtitle: 'FSRS 调度 / 到期题' },
  { to: '/learning-items', emoji: '📋', title: '学习项', subtitle: '待办 / 进行中 / 已完成' },
  { to: '/mistakes', emoji: '🗂', title: '历史', subtitle: '错题 + 知识点' },
];

export function Home() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Loom</h1>
      <p className="mt-2 text-sm text-slate-600">个人学习工具，从一张题图开始。</p>

      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {ENTRIES.map((e) => (
          <Link
            key={e.to}
            to={e.to}
            className={`block border rounded-lg p-4 hover:bg-slate-50 transition-colors ${e.primary ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}
          >
            <div className="text-3xl mb-2" aria-hidden="true">
              {e.emoji}
            </div>
            <div
              className={`text-base font-medium ${e.primary ? 'text-slate-900' : 'text-slate-800'}`}
            >
              {e.title}
            </div>
            <div className="text-xs text-slate-500 mt-1">{e.subtitle}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
