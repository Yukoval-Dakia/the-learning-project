import type { ComponentProps, ReactNode } from 'react';
import { useId, useMemo, useRef, useState } from 'react';
import remarkGfm from 'remark-gfm';
import type { MarkdownRendererProps } from '@/ui/lib/markdown-renderer';
import { MathMarkdown } from '@/ui/lib/math-markdown';

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [notice, setNotice] = useState('');
  return (
    <div className="un-cp-code-block">
      <div className="un-cp-code-tools">
        <span>代码</span>
        <button
          type="button"
          onClick={() => {
            const text = code.current?.textContent;
            if (text === undefined || !navigator.clipboard) {
              setNotice('请选中代码后复制。');
              return;
            }
            void navigator.clipboard.writeText(text).then(
              () => setNotice('已复制'),
              () => setNotice('复制失败，请选中代码后复制。'),
            );
          }}
        >
          复制
        </button>
      </div>
      <pre ref={code}>{children}</pre>
      {notice && (
        <span className="un-cp-code-notice" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

function Table({ children, node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus this horizontally scrollable table region.
    <section className="un-cp-table-scroll" aria-label="表格，可横向滚动" tabIndex={0}>
      <table {...props}>{children}</table>
    </section>
  );
}

const baseComponents: MarkdownRendererProps['components'] = { pre: CodeBlock, table: Table };

// YUK-1367 — a model sometimes writes the tool's `/practice/x` as `//practice/x`. The browser reads
// that as host `practice`, so the click leaves the app. A first part that could not be a real host
// (no dot, no port) is the in-app path with an extra slash; anything else names another host and
// stays plain text: a link that looks internal must not go elsewhere.
const PROTOCOL_RELATIVE = /^\/{2,}/;
function chatLinkHref(href: string | undefined): string | null {
  if (!href || !PROTOCOL_RELATIVE.test(href)) return href ?? null;
  const rest = href.replace(PROTOCOL_RELATIVE, '');
  const first = rest.split(/[/?#]/, 1)[0] ?? '';
  return first !== '' && !/[.:@]/.test(first) ? `/${rest}` : null;
}

// YUK-1812 — a model sometimes writes a page path with image syntax, `![去练习](/practice/x)`. That
// draws a broken image and no way in. In this app only `/api/assets/…` serves images from a site
// path, so any other one is a link the model meant to write.
type MarkdownNode = { type: string; url?: string; alt?: string | null; children?: MarkdownNode[] };
function pageImagesToLinks(node: MarkdownNode) {
  for (const [index, child] of (node.children ?? []).entries()) {
    if (child.type === 'image' && child.url?.startsWith('/') && !child.url.startsWith('/api/')) {
      const text = child.alt || '打开';
      node.children?.splice(index, 1, {
        type: 'link',
        url: child.url,
        children: [{ type: 'text', value: text } as MarkdownNode],
      });
    } else {
      pageImagesToLinks(child);
    }
  }
}
const remarkPageImagesAsLinks = () => pageImagesToLinks;

const extensions = [remarkGfm, remarkPageImagesAsLinks];

/** Conversation content supports math explicitly, independent of the page's current subject. */
export function ConversationMarkdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '');
  const components = useMemo<MarkdownRendererProps['components']>(
    () => ({
      ...baseComponents,
      h2: ({ node: _node, id, ...props }) => (
        <h2 {...props} id={id === 'footnote-label' ? `message-${instance}-footnote-label` : id} />
      ),
      a: ({ node: _node, 'aria-describedby': description, href, ...props }) => {
        const safeHref = chatLinkHref(href);
        if (href && safeHref === null) return <span>{props.children}</span>;
        return (
          <a
            {...props}
            href={safeHref ?? undefined}
            aria-describedby={
              description === 'footnote-label' ? `message-${instance}-footnote-label` : description
            }
          />
        );
      },
    }),
    [instance],
  );
  return (
    <MathMarkdown
      notation="katex"
      // YUK-1548 — the shared reading layer, in the denser rhythm of a narrow panel.
      className={['un-cp-rich-text un-read', className].filter(Boolean).join(' ')}
      data-read="compact"
      remarkPlugins={extensions}
      components={components}
      remarkRehypeOptions={{
        clobberPrefix: `message-${instance}-`,
        footnoteLabel: '注释',
        footnoteBackLabel: '返回正文',
      }}
    >
      {children}
    </MathMarkdown>
  );
}
