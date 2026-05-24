# YUK-52 — Note read UX: markdown rendering in atomic sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** atomic note 5 种 section kind 在阅读视图统一走 markdown renderer，含 GFM（table / strikethrough / task list）+ 代码高亮 + image 自适应；KaTeX gating by subject notation 不变；加 1 个 snapshot test 守住渲染合约。

**Architecture:** 现状 [`src/ui/components/ArtifactSections.tsx`](../../../src/ui/components/ArtifactSections.tsx) 已经为每个 section 调 `<MathMarkdown>` 渲染 `body_md`。本 lane **不重写 ArtifactSections**，而是在 [`src/ui/lib/math-markdown.tsx`](../../../src/ui/lib/math-markdown.tsx) 这一 single source of truth 上加 `remark-gfm` + 代码高亮（Shiki）+ image 默认样式，all surface（review / artifact / teaching / embedded check）一并受益。Snapshot 守在 ArtifactSections.test.tsx，覆盖 5 种 kind 的渲染轮廓。

**Tech Stack:** `react-markdown@9` + `remark-math@6` + `rehype-katex@7`（已装）；新增 `remark-gfm@4` + `shiki@1`（按需）；Vitest + `@testing-library/react` + `vite-tsconfig-paths`

**Lane meta:**
- Linear: [YUK-52](https://linear.app/yukoval-studios/issue/YUK-52) (2pts, M2, Medium)，sub-issue of [YUK-16](https://linear.app/yukoval-studios/issue/YUK-16)
- Wave: W2，chain-merge 位置 #3（YUK-15 之后；Note 区第 1 个）
- Git branch: `yukovaldakia09/yuk-52-note-read-ux-markdown-rendering-in-atomic-sections`
- Parent outline: [`2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.1 Sub 1
- Cross-cutting helper：无（纯 UI 层）。**但本 lane 改动 [`src/ui/lib/math-markdown.tsx`](../../../src/ui/lib/math-markdown.tsx) 是 4 个 surface 的 SoT**，change ripple 要在 PR description 列出。

**Pre-flight：**
1. `git fetch origin main && git rebase origin/main` —— 同步 W1 + 上游
2. `lsof -nP -iTCP:3000` —— 端口检查
3. `pnpm typecheck && pnpm lint`
4. Snapshot 习惯检查：`pnpm vitest run --config vitest.unit.config.ts -t snapshot`（先看仓库里现在有几条 snapshot，了解 baseline）
5. **拉一份当前 sample atomic note** —— 用 `pnpm dev` 打开任意 `/learning-items/<id>`，截一张当前 ArtifactSections 渲染图存到 PR description（before），方便 reviewer 对照后图（after）

---

## File Structure

**Modify:**
- `package.json` —— 加 `remark-gfm`、`shiki` deps
- `src/ui/lib/math-markdown.tsx` —— 加 `remark-gfm` plugin + code block highlight 钩子 + `img` 默认 `max-width:100%` style
- `src/ui/lib/math-markdown.test.tsx`（新建）—— renderer-level snapshot
- `src/ui/components/ArtifactSections.test.tsx`（新建）—— 5 种 section kind snapshot

**No changes:**
- `src/ui/components/ArtifactSections.tsx` —— 调用方不变（仍 `<MathMarkdown notation={...}>{s.body_md}</MathMarkdown>`）
- `src/core/schema/business.ts` `NoteSection` —— schema 不动
- `app/(app)/learning-items/[id]/page.tsx` —— page 调用 `<ArtifactSections>` 不动
- 其他 surface（review prompt / teaching / embedded check）—— 自动受益于 MathMarkdown 升级，**不需要单独动**

**Risk note：** MathMarkdown 是 SoT，加 GFM 后 `~~strike~~` / `| table |` / `- [x] task` 三类语法在所有 surface 都激活。这些之前会被 react-markdown 当作普通文本，升级后语义变化。PR description 必须列出。

---

## Tasks

### Task 1: UI design pre-flight (CLAUDE.md `feedback_ui_preflight`)

> 强约束。不跳。

- [ ] **Step 1: 引用 design 源**

- [`docs/modules/notes.md`](../../modules/notes.md) §3「结构化 section 模板」+ §10.2「OSS 选型」—— 5 种 section kind 列表 + react-markdown 选型；明确说"代码高亮、图表（Mermaid 留 Phase 3）"
- [`docs/superpowers/plans/2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) §M2.1 Sub 1 — issue scope
- [`src/ui/lib/math-markdown.tsx`](../../../src/ui/lib/math-markdown.tsx) 当前 surface 列表注释 —— review prompt / artifact / teaching / embedded check

- [ ] **Step 2: 声明组件类型**

- `MathMarkdown` —— **既有 component (SoT)**，inline 修改，**不抽新组件**
- snapshot test —— **test file**，不影响 production bundle

- [ ] **Step 3: 列 touch 文件**

| 文件 | 类型 |
|---|---|
| `package.json` + `pnpm-lock.yaml` | 修改（加 dep） |
| `src/ui/lib/math-markdown.tsx` | 修改 |
| `src/ui/lib/math-markdown.test.tsx` | 创建 |
| `src/ui/components/ArtifactSections.test.tsx` | 创建 |

- [ ] **Step 4: 等用户 approve**

Post 给用户：上面 3 步 + 「MathMarkdown 是 4 个 surface 的 SoT，加 GFM 是 ripple 改动；review prompt 中 `~~text~~` 之类会变成 strikethrough」。等 OK 再进 Task 2。

---

### Task 2: 加 `remark-gfm` dependency + plugin

**Files:**
- Modify: `package.json` (and `pnpm-lock.yaml` via pnpm)
- Modify: `src/ui/lib/math-markdown.tsx`

- [ ] **Step 1: 装依赖**

```bash
pnpm add remark-gfm@^4
```

Expected: `remark-gfm` shows up under `dependencies` in `package.json`.

- [ ] **Step 2: 写 failing renderer test**

Create `src/ui/lib/math-markdown.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MathMarkdown } from './math-markdown';

describe('MathMarkdown — GFM extensions', () => {
  it('renders strikethrough via ~~text~~', () => {
    const { container } = render(<MathMarkdown notation="plaintext">{'foo ~~bar~~ baz'}</MathMarkdown>);
    expect(container.querySelector('del')?.textContent).toBe('bar');
  });

  it('renders GFM table', () => {
    const md = `| h1 | h2 |\n|---|---|\n| a | b |`;
    const { container } = render(<MathMarkdown notation="plaintext">{md}</MathMarkdown>);
    expect(container.querySelectorAll('table tbody tr td')).toHaveLength(2);
  });

  it('renders task list checkbox', () => {
    const { container } = render(<MathMarkdown notation="plaintext">{'- [x] done\n- [ ] todo'}</MathMarkdown>);
    expect(container.querySelectorAll('li input[type="checkbox"]')).toHaveLength(2);
  });

  it('still renders inline math when notation=latex', () => {
    const { container } = render(<MathMarkdown notation="latex">{'value $x^2$ here'}</MathMarkdown>);
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('skips math parsing when notation=plaintext (KaTeX gating preserved)', () => {
    const { container } = render(<MathMarkdown notation="plaintext">{'value $x^2$ here'}</MathMarkdown>);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$x^2$');
  });
});
```

- [ ] **Step 3: Run test, expect fail**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx
```

Expected: FAIL — `del` / `table` / `input[type="checkbox"]` 都不存在。

- [ ] **Step 4: Wire `remark-gfm` into MathMarkdown**

Edit `src/ui/lib/math-markdown.tsx`. Replace the plugin chain construction with:

```tsx
import type { ComponentProps, HTMLAttributes, ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export interface MathMarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: string;
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

/**
 * Shared markdown renderer. SoT for: review prompt / reference / feedback,
 * artifact note section body, teaching turn text, embedded check.
 *
 * Always-on: remark-gfm (tables, strikethrough, task lists, autolinks).
 * Conditional: remark-math + rehype-katex when notation === 'latex'.
 */
export function MathMarkdown({ children, notation, ...divProps }: MathMarkdownProps): ReactElement {
  const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [remarkGfm];
  const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [];
  if (notation === 'latex') {
    remarkPlugins.push(remarkMath);
    rehypePlugins.push(rehypeKatex);
  }
  return (
    <div {...divProps}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 5: Run test, expect pass**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx
```

Expected: PASS (5 assertions).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ui/lib/math-markdown.tsx src/ui/lib/math-markdown.test.tsx
git commit -m "feat(ui): add remark-gfm to MathMarkdown (YUK-52)"
```

---

### Task 3: Code block 高亮（Shiki，按需 lazy load）

**Files:**
- Modify: `package.json`
- Modify: `src/ui/lib/math-markdown.tsx`
- Modify: `src/ui/lib/math-markdown.test.tsx`

> **取舍**：Shiki bundle 较重（含 grammars），但运行时按需 import 语言；本 lane 采用 `rehype-shiki@2` 的 lazy-grammar 模式。如果团队偏好更轻的方案，可改成 `highlight.js` —— 但 Shiki 跟 VS Code grammar 对齐，结果可读性更稳。**启动前确认这条选型，再开始 Task 3**。

- [ ] **Step 1: 装依赖**

```bash
pnpm add shiki@^1 @shikijs/rehype@^1
```

- [ ] **Step 2: 写 failing test**

Append to `src/ui/lib/math-markdown.test.tsx`:

```tsx
describe('MathMarkdown — code highlight', () => {
  it('highlights fenced code block as ts', async () => {
    const md = '```ts\nconst x: number = 1\n```';
    const { container, findByText } = render(<MathMarkdown notation="plaintext">{md}</MathMarkdown>);
    // Shiki wraps tokens in <span> with inline color style
    const codeBlock = await findByText(/const/, { exact: false });
    expect(codeBlock.closest('pre')).toBeTruthy();
    expect(codeBlock.closest('pre')?.getAttribute('class') ?? '').toMatch(/shiki|hljs|language-ts/);
  });
});
```

- [ ] **Step 3: Run test, expect fail**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx -t 'code highlight'
```

Expected: FAIL — no Shiki class.

- [ ] **Step 4: Wire `@shikijs/rehype` into MathMarkdown**

Replace the plugin chain in `src/ui/lib/math-markdown.tsx`:

```tsx
import rehypeShiki from '@shikijs/rehype';
// ...
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeShiki, { theme: 'github-light', defaultLanguage: 'text' }],
];
if (notation === 'latex') {
  remarkPlugins.push(remarkMath);
  rehypePlugins.push(rehypeKatex);
}
```

Note: rehypeShiki should come **before** rehypeKatex; KaTeX output passes through Shiki harmlessly. If SSR fails due to Shiki using top-level await, downgrade to `rehype-pretty-code` or move to `shiki@2`'s singleton API — confirm by running:

```bash
pnpm typecheck
```

- [ ] **Step 5: Run test, expect pass**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx -t 'code highlight'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ui/lib/math-markdown.tsx src/ui/lib/math-markdown.test.tsx
git commit -m "feat(ui): add Shiki code highlight to MathMarkdown (YUK-52)"
```

---

### Task 4: Image 默认 `max-width: 100%` 样式

**Files:**
- Modify: `src/ui/lib/math-markdown.tsx`

- [ ] **Step 1: 写 failing test**

Append to `src/ui/lib/math-markdown.test.tsx`:

```tsx
describe('MathMarkdown — image rendering', () => {
  it('renders image with responsive max-width default', () => {
    const { container } = render(<MathMarkdown notation="plaintext">{'![alt](https://example.com/x.png)'}</MathMarkdown>);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('alt')).toBe('alt');
    expect(getComputedStyle(img!).maxWidth || img!.style.maxWidth).toMatch(/100%/);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx -t 'image rendering'
```

Expected: FAIL — no inline style.

- [ ] **Step 3: Override `img` component in MathMarkdown**

In `src/ui/lib/math-markdown.tsx`, pass `components` prop to `<ReactMarkdown>`:

```tsx
<ReactMarkdown
  remarkPlugins={remarkPlugins}
  rehypePlugins={rehypePlugins}
  components={{
    img: ({ node: _node, ...imgProps }) => (
      <img {...imgProps} style={{ maxWidth: '100%', height: 'auto', ...(imgProps.style ?? {}) }} alt={imgProps.alt ?? ''} />
    ),
  }}
>
  {children}
</ReactMarkdown>
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx -t 'image rendering'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/math-markdown.tsx src/ui/lib/math-markdown.test.tsx
git commit -m "feat(ui): default responsive image style in MathMarkdown (YUK-52)"
```

---

### Task 5: ArtifactSections snapshot test 守 5 种 kind 渲染

**Files:**
- Create: `src/ui/components/ArtifactSections.test.tsx`

- [ ] **Step 1: Write snapshot test**

Create `src/ui/components/ArtifactSections.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ArtifactSections, type ArtifactSection } from './ArtifactSections';

const FIVE_KINDS: ArtifactSection[] = [
  { id: 'sec_def', kind: 'definition', body_md: '**核心**：foo 是 bar。', source_tier: 'llm_only', user_verified: false, embedded_check: null, version: 1 },
  { id: 'sec_mech', kind: 'mechanism', body_md: '步骤：\n1. 第一\n2. 第二\n\n```ts\nconst x = 1;\n```', source_tier: 'search_grounded', user_verified: false, embedded_check: null, version: 1 },
  { id: 'sec_ex', kind: 'example', body_md: '| 输入 | 输出 |\n|---|---|\n| a | b |', source_tier: 'textbook', user_verified: true, embedded_check: null, version: 1 },
  { id: 'sec_pit', kind: 'pitfall', body_md: '常见错误 ~~deprecated~~ 现已修正。', source_tier: 'user_verified', user_verified: true, embedded_check: null, version: 1 },
  { id: 'sec_chk', kind: 'check', body_md: '完成下面任务：\n- [ ] 一\n- [x] 二', source_tier: 'llm_only', user_verified: false, embedded_check: { question_ids: [] }, version: 1 },
];

const WENYAN_PROFILE = {
  id: 'wenyan',
  displayName: '文言',
  renderConfig: { notation: 'plaintext' as const },
};

describe('ArtifactSections — 5 section kinds snapshot', () => {
  it('renders definition / mechanism / example / pitfall / check with stable structure', () => {
    const { container } = render(
      <ArtifactSections
        sections={FIVE_KINDS}
        subjectProfile={WENYAN_PROFILE as never}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(container.querySelectorAll('.artifact-section')).toHaveLength(5);
    expect(container.querySelector('table')).toBeTruthy(); // example
    expect(container.querySelector('pre')).toBeTruthy(); // mechanism code block
    expect(container.querySelector('del')).toBeTruthy(); // pitfall ~~strike~~
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2); // check task list
    expect(container).toMatchSnapshot();
  });

  it('renders with KaTeX when subject notation=latex', () => {
    const mathSection: ArtifactSection[] = [
      { ...FIVE_KINDS[0], body_md: '面积为 $\\pi r^2$。' },
    ];
    const MATH_PROFILE = { ...WENYAN_PROFILE, id: 'math', displayName: '数学', renderConfig: { notation: 'latex' as const } };
    const { container } = render(
      <ArtifactSections sections={mathSection} subjectProfile={MATH_PROFILE as never} embeddedQuestions={[]} embeddedCheckStatus="not_required" />,
    );
    expect(container.querySelector('.katex')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test, expect pass (creates snapshot)**

```bash
pnpm vitest run --config vitest.unit.config.ts src/ui/components/ArtifactSections.test.tsx
```

Expected: PASS — snapshot file generated under `src/ui/components/__snapshots__/ArtifactSections.test.tsx.snap`.

- [ ] **Step 3: Sanity check snapshot diff**

```bash
git diff src/ui/components/__snapshots__/ArtifactSections.test.tsx.snap
```

Verify the snapshot includes: 5 `.artifact-section` divs, 1 `<table>`, 1 `<pre>` with shiki classes, 1 `<del>`, 2 task-list checkboxes, KaTeX wrapper for math section.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/ArtifactSections.test.tsx src/ui/components/__snapshots__/
git commit -m "test(ui): ArtifactSections 5-kind snapshot (YUK-52)"
```

---

### Task 6: 浏览器 smoke + 截图对照

**Files:** none (manual)

- [ ] **Step 1: Start dev server**

```bash
lsof -nP -iTCP:3000  # ensure port free
pnpm dev
```

- [ ] **Step 2: 准备 fixture atomic note**

If no atomic note with rich markdown exists locally, create one via:

```bash
# Insert a sample artifact row with sections containing table / code / image / task list / strike
pnpm tsx -e "
import { db } from './src/db/client';
import { artifact } from './src/db/schema';
import { createId } from '@paralleldrive/cuid2';
const now = new Date();
await db.insert(artifact).values({
  id: createId(),
  type: 'note_atomic',
  title: 'YUK-52 smoke fixture',
  knowledge_id: null,
  intent_source: 'declared',
  source: 'manual',
  sections: [{ id: 'def', kind: 'definition', body_md: '**核心**：测试。\\n\\n| h | b |\\n|---|---|\\n| a | b |', source_tier: 'llm_only', user_verified: false, embedded_check: null, version: 1 }],
  generation_status: 'ready',
  verification_status: 'not_required',
  embedded_check_status: 'not_required',
  history: [],
  created_at: now,
  updated_at: now,
  version: 0,
} as never);
console.log('inserted');
process.exit(0);
"
```

- [ ] **Step 3: Open the page**

Open `http://localhost:3000/learning-items/<learning-item-id-pointing-to-this-artifact>`. Verify table / code block / strikethrough / task list / image all render.

- [ ] **Step 4: 截图存档**

Capture before / after screenshots, attach to PR description.

---

### Task 7: 全 lane test gate + ripple verification

**Files:** none (commands only)

- [ ] **Step 1: Run all surfaces' tests to confirm no regression**

```bash
pnpm typecheck
pnpm lint
pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx src/ui/components/ArtifactSections.test.tsx
# Other surfaces that already test MathMarkdown indirectly
pnpm vitest run --config vitest.unit.config.ts -t MathMarkdown
```

Expected: all green.

- [ ] **Step 2: Full pre-PR gate**

```bash
pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test
```

All green → PR-ready.

- [ ] **Step 3: PR description ripple note**

Include the following in PR description (per Risk note above):

> ⚠️ MathMarkdown is the SoT for 4 surfaces (review prompt / artifact section / teaching turn / embedded check). This PR adds `remark-gfm`, which activates `~~strike~~` / GFM tables / `- [x] task list` semantics across all surfaces. Code blocks now highlight via Shiki. Images get a default `max-width: 100%`. Verified no visual regression on review page (screenshot attached).

---

## Exit criteria recap (mirror Linear acceptance)

- [ ] atomic note section markdown 渲染（含 code block / image / list / table / strike / task list）—— Task 2-5 cover
- [ ] 与现有 KaTeX gating 兼容（math subject）—— Task 2 test 4-5 + Task 5 math case
- [ ] 无 hydration mismatch —— Task 6 manual smoke + Shiki SSR sanity in Task 3 Step 4
- [ ] 至少 1 个 visual regression test（snapshot 或 storybook）—— Task 5 ArtifactSections snapshot

## Linear capture gate（PR 前）

- Shiki bundle size 报告：跑一次 `pnpm build` 看 `app/(app)/learning-items/[id]` 路由 bundle 涨幅，若 > 100 KB 开 follow-up issue 调研 `rehype-pretty-code` 或 `shiki/web` 缩小子集
- 若需要 Mermaid 图（YUK-52 不在 scope，留 follow-up）：开 issue「Note 渲染：Mermaid block 支持」
- PR title 用 Linear branch 名；commit message 含 `Closes YUK-52` 触发 integration

## ADR 触发判断

不触发。`remark-gfm` / Shiki / image 默认样式都是渲染层增强，不影响：
- Schema / 持久化形态（NoteSection 不动）
- KnownEvent（无新 action）
- Subject profile（renderConfig.notation gating 不动）

如果后续决定加 Mermaid（block diagram）需要看是否走 Shiki 同款 rehype plugin 模式；若引入 client-only renderer 影响 SSR，需 ADR。
