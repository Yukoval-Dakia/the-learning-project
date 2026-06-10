// ADR-0033 D4 (YUK-306) — sandboxed renderer for interactive artifacts
// (attrs.html). FIRST sandboxed-user-content surface in this repo; the entire
// security model lives in this file (the backend stores attrs.html opaquely).
//
// Threat model (ADR-0033 verbatim): 单用户自用工具，威胁不是恶意作者，是 LLM 写错 /
// 被读到的内容 prompt-injection 后生成会外泄的 JS。去 same-origin + 禁网 CSP 即足以
// 兜住；不必上更重隔离。
//
// The two load-bearing layers:
// 1. <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin → the document
//    runs in a null origin: no parent DOM, no cookies, no localStorage, no
//    credentialed same-origin fetch. Also deliberately absent: allow-forms,
//    allow-popups, allow-modals, allow-top-navigation, allow-downloads.
// 2. A network-deny CSP <meta> emitted as the FIRST parsed element of the
//    srcdoc document (see withCsp: the artifact HTML is always wrapped in a
//    shell whose head carries the meta, so no artifact content can parse
//    before the policy applies) → inline script/style run, but no connect-src /
//    external script / external img / form-action exists, so generated JS has
//    no network exfiltration channel beyond the accepted residuals below.
//
// Accepted residuals (ADR-0033 — all in the "frame holds no user data" class):
// the sandboxed frame can still self-navigate to an external URL with params
// (CSP has no enforceable navigate-to), and weaker kin like <a ping> /
// dns-prefetch hints; nothing inside the frame can read parent data, so the
// channel carries only what the artifact itself already contains.
//
// Why no sanitizer / no dangerouslySetInnerHTML: the HTML goes through the
// `srcDoc` PROP, so React escapes it as an attribute value and the iframe's own
// parser un-escapes it — the host document never parses the artifact markup.

import { useMemo } from 'react';

// Per-directive rationale:
// - default-src 'none'        — network-deny baseline: connect/frame/object/
//                               worker/external script/css all unreachable (no
//                               scheme or host source anywhere → zero network).
// - script-src 'unsafe-inline' 'unsafe-eval'
//                             — self-contained inline JS must run; 'unsafe-eval'
//                               is not an exfil channel (threat model is exfil
//                               only) and buys generated-content compatibility.
//                               No host source → external scripts stay blocked.
//                               Severable: dropping 'unsafe-eval' is safe.
// - style-src 'unsafe-inline' — inline <style> / style attrs; @import url(...)
//                               stays blocked (no host source).
// - img/font/media data:/blob: — locally-embedded assets render; http(s) doesn't.
// - base-uri 'none' / form-action 'none'
//                             — these do NOT fall back to default-src, so they
//                               are pinned explicitly: no <base> rewrite, no
//                               form-submit exfil (double cover with the
//                               sandbox's missing allow-forms).
const CSP_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP_POLICY}">`;

/**
 * Build the srcdoc document: ALWAYS wrap the artifact HTML in a minimal shell
 * whose head carries the network-deny CSP meta.
 *
 * Why unconditional (no head-detection/injection): a CSP <meta> only
 * constrains content parsed AFTER it. Any attempt to inject into the input's
 * own markup is bypassable by adversarial shape — active content before the
 * first <head> (`<img src=//evil/leak><head>`) or a commented-out `<head>`
 * stealing the injection point — and the threat model here is exactly
 * adversarially-shaped LLM output. Wrapping guarantees the meta is the first
 * parsed element with zero artifact content preceding it.
 *
 * HTML parser merge semantics make the wrap robust for full-document inputs:
 * a stray <head> start tag in body context is ignored, duplicate <html> merges
 * attributes, inner doctypes are dropped (the OUTER doctype keeps standards
 * mode), and any embedded second CSP meta can only TIGHTEN (policies
 * intersect, never loosen). Cost: original head-only children (<title>,
 * <style>) parse in body context — <style> still applies document-wide;
 * acceptable for self-contained content (ADR-0033 反过度工程).
 */
function withCsp(html: string): string {
  return `<!doctype html><html><head>${CSP_META}</head><body>${html}</body></html>`;
}

export interface InteractiveArtifactRendererProps {
  /** attrs.html verbatim — stored opaquely server-side; security is this layer. */
  html: string;
  /** artifact.title, feeding the iframe's a11y title. */
  title: string;
}

export function InteractiveArtifactRenderer({ html, title }: InteractiveArtifactRendererProps) {
  const doc = useMemo(() => withCsp(html), [html]);
  // Bounded height: surrounding note bodies are document-flow (no fixed height),
  // but an iframe must be sized — fixed default + native CSS resize affordance
  // on the shell (zero JS; no postMessage height protocol per ADR-0033 D4).
  return (
    <div className="note-interactive-shell">
      <iframe
        className="note-interactive-frame"
        title={title || '互动内容'}
        sandbox="allow-scripts"
        srcDoc={doc}
        loading="lazy"
      />
    </div>
  );
}
