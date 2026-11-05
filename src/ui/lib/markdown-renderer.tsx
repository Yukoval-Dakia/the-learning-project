import type { ComponentProps, ComponentType, HTMLAttributes, ReactElement } from 'react';
import ReactMarkdown, {
  type Components,
  type ExtraProps,
  defaultUrlTransform,
} from 'react-markdown';
import { BLOCK_REF_SCHEME, TLP_BLOCK_FENCE_INFO } from '@/core/schema/blocks';
import { BlockSkeleton } from '@/ui/components/blocks/BlockSkeleton';
import { BlockFenceView } from '@/ui/components/blocks/BlockView';
import { BLOCK_DRAFT_FENCE_INFO, parseDraftBody } from '@/ui/components/blocks/block-fence';

export interface MarkdownRendererProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children: string;
  remarkPlugins?: ComponentProps<typeof ReactMarkdown>['remarkPlugins'];
  rehypePlugins?: ComponentProps<typeof ReactMarkdown>['rehypePlugins'];
  components?: ComponentProps<typeof ReactMarkdown>['components'];
  remarkRehypeOptions?: ComponentProps<typeof ReactMarkdown>['remarkRehypeOptions'];
}

type HastNode = NonNullable<ExtraProps['node']>;
type PreProps = ComponentProps<'pre'> & ExtraProps;
type ImgProps = ComponentProps<'img'> & ExtraProps;

/** `info` + body of a fenced code block, read from the hast node rather than rendered children. */
function fenceOf(node: HastNode | undefined): { info: string; body: string } | null {
  const code = node?.children.find(
    (child): child is HastNode => child.type === 'element' && child.tagName === 'code',
  );
  if (!code) return null;
  const classes = code.properties.className;
  const language = Array.isArray(classes)
    ? classes.find(
        (name): name is string => typeof name === 'string' && name.startsWith('language-'),
      )
    : undefined;
  if (!language) return null;
  const body = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
  return { info: language.slice('language-'.length), body: body.trim() };
}

// One stable wrapper per caller component, so a re-render (every streamed delta) keeps the same
// element types and never remounts a block that is already on screen.
const preWrappers = new WeakMap<object, ComponentType<PreProps>>();
const imgWrappers = new WeakMap<object, ComponentType<ImgProps>>();

function NativePre({ node: _node, ...props }: PreProps) {
  return <pre {...props} />;
}

function NativeImg({ node: _node, alt, ...props }: ImgProps) {
  return <img {...props} alt={alt} />;
}

function blockAwarePre(Inner: ComponentType<PreProps>): ComponentType<PreProps> {
  let wrapper = preWrappers.get(Inner);
  if (!wrapper) {
    // YUK-1548 §2.2 — a `tlp-block` fence is a block, not code: it renders through BlockView on
    // every Markdown surface. The draft fence is the chat composer's stand-in while one streams.
    wrapper = function BlockAwarePre(props: PreProps) {
      const fence = fenceOf(props.node);
      if (fence?.info === TLP_BLOCK_FENCE_INFO) return <BlockFenceView body={fence.body} />;
      if (fence?.info === BLOCK_DRAFT_FENCE_INFO) {
        return <BlockSkeleton {...parseDraftBody(fence.body)} />;
      }
      return <Inner {...props} />;
    };
    preWrappers.set(Inner, wrapper);
  }
  return wrapper;
}

function blockAwareImg(Inner: ComponentType<ImgProps>): ComponentType<ImgProps> {
  let wrapper = imgWrappers.get(Inner);
  if (!wrapper) {
    // A draft `![alt](block:<ref>)` that nothing resolved: keep its words, never a broken image.
    wrapper = function BlockAwareImg(props: ImgProps) {
      if (typeof props.src === 'string' && props.src.startsWith(BLOCK_REF_SCHEME)) {
        return <span className="un-blk-ref">{props.alt}</span>;
      }
      return <Inner {...props} />;
    };
    imgWrappers.set(Inner, wrapper);
  }
  return wrapper;
}

function asComponent<P>(value: unknown, fallback: ComponentType<P>): ComponentType<P> {
  return typeof value === 'function' || (typeof value === 'object' && value !== null)
    ? (value as ComponentType<P>)
    : fallback;
}

function withBlocks(components: Components | null | undefined): Components {
  return {
    ...components,
    pre: blockAwarePre(asComponent<PreProps>(components?.pre, NativePre)),
    img: blockAwareImg(asComponent<ImgProps>(components?.img, NativeImg)),
  };
}

/** Draft refs (`block:<ref>`) survive on images only; every other URL keeps the safe default. */
function blockUrlTransform(url: string, key: string, node: Readonly<HastNode>): string {
  if (key === 'src' && node.tagName === 'img' && url.startsWith(BLOCK_REF_SCHEME)) return url;
  return defaultUrlTransform(url);
}

/**
 * Safe Markdown shell with no optional syntax plugins in its module graph.
 * ReactMarkdown ignores raw HTML by default; callers opt into math support through
 * MathMarkdown instead of making every Markdown-only surface download KaTeX.
 * `tlp-block` fences render as blocks (YUK-1548); Mermaid loads only when a diagram mounts.
 */
export function MarkdownRenderer({
  children,
  remarkPlugins,
  rehypePlugins,
  components,
  remarkRehypeOptions,
  ...divProps
}: MarkdownRendererProps): ReactElement {
  return (
    <div {...divProps}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={withBlocks(components)}
        remarkRehypeOptions={remarkRehypeOptions}
        urlTransform={blockUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
