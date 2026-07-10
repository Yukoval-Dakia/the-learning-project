// YUK-602 — /welcome 手填科目入口 + 通用模式 badge 的 SSR 覆盖（renderToString，
// node env，无 jsdom 无交互——focus-within 收起 / blur-vs-click / Esc 等交互路径由
// design doc §5 手工验收承接）。QueryClientProvider + setQueryData 喂 subjectRows
// （VisionTab.test.tsx 先例：initialData/缓存命中 → SSR 零请求零 effect）。

import { createSubjectErrorText } from '@/ui/hooks/useCreateSubject';
import { type ApiSubject, SUBJECTS_QUERY_KEY } from '@/ui/hooks/useSubjects';
import { ApiAuthError, ApiError } from '@/ui/lib/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WelcomePage, { CreateSubjectForm } from './WelcomePage';

function subj(overrides: Partial<ApiSubject> & Pick<ApiSubject, 'id' | 'displayName'>): ApiSubject {
  return {
    renderConfig: { font_family: 'sans', notation: null, code_highlight: null },
    causeCategories: [],
    isGeneralFallback: false,
    ...overrides,
  };
}

function renderWelcome(rows?: ApiSubject[]): string {
  const qc = new QueryClient();
  if (rows) qc.setQueryData(SUBJECTS_QUERY_KEY, rows);
  return renderToString(
    <QueryClientProvider client={qc}>
      <WelcomePage navigate={() => {}} />
    </QueryClientProvider>,
  );
}

describe('WelcomePage —「+ 新科目」入口（YUK-602 §1.1）', () => {
  it('renders the collapsed dashed chip in the 学科视角 row', () => {
    const html = renderWelcome();
    expect(html).toContain('ob-new-subject');
    expect(html).toContain('+ 新科目');
  });
});

describe('WelcomePage — 通用模式 badge（YUK-602 §1.2）', () => {
  it('suffixes 通用 on isGeneralFallback===true rows only (flag joined from subjectRows)', () => {
    const html = renderWelcome([
      subj({ id: 'yuwen', displayName: '语文' }),
      subj({ id: 'subj_x1', displayName: '化学', isGeneralFallback: true }),
    ]);
    expect(html).toContain('化学');
    // badge 只挂 学科视角 行的化学 chip 上——恰好 1 枚（builtin false 无标；
    // leanings 行不挂标，badge 语义属于科目选择上下文）。
    expect(html.split('ob-chip-badge').length - 1).toBe(1);
    expect(html).toContain('通用');
  });

  it('null flag (general 防御位) never renders a badge', () => {
    const html = renderWelcome([subj({ id: 'subj_g', displayName: 'X', isGeneralFallback: null })]);
    expect(html.split('ob-chip-badge').length - 1).toBe(0);
  });
});

describe('CreateSubjectForm（展示件，纯 props）', () => {
  const noop = () => {};

  it('pins the input contract: placeholder + maxLength 32, empty name disables submit', () => {
    const html = renderToString(
      <CreateSubjectForm name="" onName={noop} onSubmit={noop} isPending={false} error={null} />,
    );
    expect(html).toContain('科目名，如：化学');
    // React 版本间 SSR 属性大小写有别（maxlength vs maxLength）——大小写无关断言。
    expect(html).toMatch(/maxlength="32"/i);
    expect(html).toContain('disabled');
    expect(html).toContain('创建');
  });

  it('renders the 422 server message verbatim（错误合同 = server 文案直出，UI 不改写）', () => {
    const msg = "display name '语文' collides with builtin subject 'yuwen'";
    const html = renderToString(
      <CreateSubjectForm name="语文" onName={noop} onSubmit={noop} isPending={false} error={msg} />,
    );
    expect(html).toContain('collides with builtin subject');
    expect(html).toContain('ob-new-subject-err');
  });

  it('pending: input readOnly + button disabled shows 创建中', () => {
    const html = renderToString(
      <CreateSubjectForm name="化学" onName={noop} onSubmit={noop} isPending error={null} />,
    );
    expect(html).toMatch(/readonly/i);
    expect(html).toContain('创建中');
  });
});

describe('createSubjectErrorText（YUK-602 §1.4 错误合同映射）', () => {
  it('422 → server 文案（thin-create 把人类可读 message 放 body.error → ApiError.code）', () => {
    const err = new ApiError(
      '422 Unprocessable Entity',
      422,
      "display name '语文' collides with builtin subject 'yuwen'",
    );
    expect(createSubjectErrorText(err)).toContain('collides with builtin subject');
  });

  it('400 → 科目名无效', () => {
    expect(
      createSubjectErrorText(
        new ApiError('400 Bad Request', 400, 'displayName (string) is required'),
      ),
    ).toBe('科目名无效');
  });

  it('token 缺失 → ApiAuthError 原文', () => {
    expect(createSubjectErrorText(new ApiAuthError('未设置 internal token'))).toBe(
      '未设置 internal token',
    );
  });

  it('网络/未知错误 → 可重试提示（API 幂等，直接重试安全）', () => {
    expect(createSubjectErrorText(new TypeError('fetch failed'))).toBe('网络错误，可直接重试');
  });
});
