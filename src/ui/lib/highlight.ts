// Syntax highlighting with Shiki, loaded on demand.
// Uses Shiki's JavaScript regex engine (no WebAssembly), which works under the
// extension's strict Content Security Policy.

import type { HighlighterCore } from 'shiki/core';
import type { Root } from 'hast';

const LANGS: Record<string, () => Promise<unknown>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  bash: () => import('@shikijs/langs/bash'),
  python: () => import('@shikijs/langs/python'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  sql: () => import('@shikijs/langs/sql'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  diff: () => import('@shikijs/langs/diff'),
  toml: () => import('@shikijs/langs/toml'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  xml: () => import('@shikijs/langs/xml'),
  graphql: () => import('@shikijs/langs/graphql'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', yml: 'yaml', md: 'markdown',
  rs: 'rust', 'c++': 'cpp', cs: 'csharp', rb: 'ruby', kt: 'kotlin', docker: 'dockerfile', svg: 'xml',
  htm: 'html', patch: 'diff', gql: 'graphql', jsonc: 'json', json5: 'json',
};

export function normaliseLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const name = ALIASES[l] ?? l;
  return name in LANGS ? name : null;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

async function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/themes/github-light'),
      import('@shikijs/themes/github-dark'),
    ]);
    return createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

/** Highlight code; resolves to null for unknown languages. Text content is preserved exactly. */
export async function highlight(code: string, lang: string | undefined): Promise<Root | null> {
  const name = normaliseLang(lang);
  if (!name) return null;
  const h = await highlighter();
  if (!loaded.has(name)) {
    const mod = (await LANGS[name]!()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] };
    await h.loadLanguage(mod.default);
    loaded.add(name);
  }
  return h.codeToHast(code, {
    lang: name,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  }) as Root;
}
