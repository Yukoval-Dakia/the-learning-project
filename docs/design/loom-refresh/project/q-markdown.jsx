// Loom · tiny markdown + LaTeX renderer for question stems / answers.
// Handles: $…$ / $$…$$ (KaTeX), **bold**, `code`, full-width 「」, line breaks.
// Safe: escapes HTML first, then re-introduces a small whitelist.
(function () {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function tex(src, display) {
    if (window.katex) {
      try { return window.katex.renderToString(src, { displayMode: display, throwOnError: false, output: "html" }); }
      catch (e) { /* fall through */ }
    }
    // graceful fallback before KaTeX loads
    return '<code class="q-tex-raw">' + esc(src) + "</code>";
  }

  // protect math spans from markdown escaping, render after
  function renderInline(text) {
    const slots = [];
    let s = text
      .replace(/\$\$([^$]+)\$\$/g, (_, m) => { slots.push(tex(m, true)); return "\u0000" + (slots.length - 1) + "\u0000"; })
      .replace(/\$([^$\n]+)\$/g, (_, m) => { slots.push(tex(m, false)); return "\u0000" + (slots.length - 1) + "\u0000"; });
    s = esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong class="q-em">$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="q-code">$1</code>')
      .replace(/＿＿+/g, '<span class="q-blank"></span>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
    return s;
  }

  function toHtml(src) {
    if (!src) return "";
    return src.split(/\n{2,}/).map((para) =>
      "<p>" + para.split(/\n/).map(renderInline).join("<br/>") + "</p>"
    ).join("");
  }

  // block renderer (stem / answer / passage)
  function QMarkdown({ text, className = "" }) {
    return React.createElement("div", {
      className: "q-md " + className,
      dangerouslySetInnerHTML: { __html: toHtml(text) },
    });
  }
  // single-line / summary renderer (no <p> wrapping)
  function QInline({ text, className = "" }) {
    return React.createElement("span", {
      className: "q-md-inline " + className,
      dangerouslySetInnerHTML: { __html: renderInline((text || "").replace(/\n+/g, " ")) },
    });
  }
  // true only when the text contains renderable markup (latex / bold / code / blank)
  function qHasMarkup(s) { return /\$|`|\*\*|＿/.test(s || ""); }
  Object.assign(window, { QMarkdown, QInline, qHasMarkup });
})();
