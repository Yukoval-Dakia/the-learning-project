// katex ships no declaration for its mhchem extension (verified 2026-11-03, katex 0.16.47: the
// `./contrib/mhchem` export points at plain .mjs). It is imported only for its side effect: it
// registers `\ce` / `\pu` into the katex module it imports (YUK-1548 §3.3).
declare module 'katex/contrib/mhchem';
