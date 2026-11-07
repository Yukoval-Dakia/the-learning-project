import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const optionalDbosLoggers = ['winston', 'winston-transport'];

export default defineConfig(({ command }) => ({
  root: resolve(import.meta.dirname, '../..'),
  base: '/_build/',
  plugins: [
    tanstackStart({
      srcDirectory: 'server/start',
      router: { basepath: '/' },
      sitemap: { enabled: false },
    }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, '../../src') } },
  // The build keeps the fetch-style server self-contained for the Node/Compose image; the dev
  // server (server/dev-frontdoor.ts) leaves node_modules external so CJS deps load natively.
  ssr:
    command === 'build'
      ? { noExternal: true, external: optionalDbosLoggers }
      : { external: optionalDbosLoggers },
  environments: {
    ssr: { build: { rolldownOptions: { external: optionalDbosLoggers } } },
    // Every script is a separate request, and on a slow link each one waits its turn. Libraries
    // every page loads go in a few shared files instead of dozens of small ones. The formula
    // renderer stays its own file because only pages with formulas fetch it; markdown ranks above
    // it so the parts both use land in markdown and math is never pulled in up front.
    client: {
      build: {
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: 'react',
                  test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                  priority: 50,
                },
                { name: 'tanstack', test: /node_modules[\\/]@tanstack[\\/]/, priority: 40 },
                { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/, priority: 30 },
                {
                  name: 'math',
                  test: /node_modules[\\/](katex|rehype-katex|remark-math|micromark-extension-math|mdast-util-math|hast-util-from-html-isomorphic)[\\/]/,
                  priority: 20,
                },
                {
                  name: 'markdown',
                  test: /node_modules[\\/](react-markdown|remark-(?!math)[^\\/]+|rehype-(?!katex)[^\\/]+|micromark(?!-extension-math)[^\\/]*|mdast-(?!util-math)[^\\/]+|hast-(?!util-from-html-isomorphic)[^\\/]+|unist-[^\\/]+|vfile[^\\/]*|unified|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities[^\\/]*|ccount|devlop|bail|trough|is-plain-obj|html-url-attributes|zwitch|longest-streak|markdown-table|estree-util-[^\\/]+|style-to-[^\\/]+|inline-style-parser|trim-lines|escape-string-regexp|web-namespaces|html-void-elements)[\\/]/,
                  priority: 25,
                },
                {
                  name: 'ui',
                  test: /[\\/]src[\\/](ui-next|ui[\\/]lib|ui[\\/]primitives)[\\/]/,
                  minShareCount: 2,
                  priority: 10,
                },
              ],
            },
          },
        },
      },
    },
  },
  build: { outDir: 'dist/start' },
}));
