import { Archive, BookOpen, Camera, ListChecks, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

interface EntryCard {
  to: string;
  Icon: LucideIcon;
  title: string;
  subtitle: string;
  primary?: boolean;
}

const ENTRIES: EntryCard[] = [
  {
    to: '/capture',
    Icon: Camera,
    title: '录题',
    subtitle: '上传图片，OCR + AI 兜底',
    primary: true,
  },
  { to: '/review', Icon: BookOpen, title: '复习', subtitle: 'FSRS 调度 / 到期题' },
  { to: '/learning-items', Icon: ListChecks, title: '学习项', subtitle: '待办 / 进行中 / 已完成' },
  { to: '/mistakes', Icon: Archive, title: '历史', subtitle: '错题 + 知识点' },
];

export function Home() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Loom</h1>
      <p className="mt-2 text-sm text-slate-600">个人学习工具，从一张题图开始。</p>

      <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {ENTRIES.map(({ to, Icon, title, subtitle, primary }) => (
          <Link
            key={to}
            to={to}
            className={`block border rounded-lg p-4 hover:bg-slate-50 transition-colors ${primary ? 'border-slate-900 bg-slate-50' : 'border-slate-200'}`}
          >
            <Icon
              className={`mb-2 ${primary ? 'text-slate-900' : 'text-slate-700'}`}
              size={28}
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <div
              className={`text-base font-medium ${primary ? 'text-slate-900' : 'text-slate-800'}`}
            >
              {title}
            </div>
            <div className="text-xs text-slate-500 mt-1">{subtitle}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
