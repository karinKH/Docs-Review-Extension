// Markdown -> HTML AST (hast) pipeline with an exact source map.
//
// Every rendered element and text run carries `data-sp="start:end"`: the UTF-16
// offsets of the Markdown source it came from. Code blocks carry `data-code`
// (first content line and fence indent) so a character inside a code block maps
// back to its exact source character.
//
// Security: raw HTML inside Markdown is parsed and then sanitised with a
// GitHub-style allow-list (no scripts, no event handlers, no javascript: URLs).
// The extension's Content Security Policy blocks inline scripts as a second layer.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import GithubSlugger from 'github-slugger';
import { visit, SKIP } from 'unist-util-visit';
import type { Root as MdRoot, Heading, Nodes as MdNodes } from 'mdast';
import type { Root as HRoot, Element, ElementContent, Text as HText, Properties } from 'hast';
import type { BlockKind } from '../types';

export interface OutlineEntry {
  depth: number;
  text: string;
  slug: string;
  /** Offsets of the heading line itself. */
  start: number;
  end: number;
  /** End of the section the heading opens (next heading of same or higher level). */
  sectionEnd: number;
  line: number;
}

export interface BlockInfo {
  kind: BlockKind;
  start: number;
  end: number;
  /** Nesting depth in the Markdown tree (document children = 1). */
  depth: number;
}

export interface RenderResult {
  hast: HRoot;
  outline: OutlineEntry[];
  blocks: BlockInfo[];
  /** Remote image URLs found (not loaded unless the user allows it). */
  remoteImages: string[];
}

export interface RenderOptions {
  /** Base URL used to resolve relative links and images. */
  baseUrl?: string;
}

const BLOCK_KINDS = new Set<string>([
  'heading',
  'paragraph',
  'listItem',
  'list',
  'blockquote',
  'code',
  'math',
  'table',
  'tableRow',
  'tableCell',
  'html',
  'thematicBreak',
  'definition',
  'footnoteDefinition',
  'yaml',
]);

const DIR_AUTO_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'blockquote', 'dt', 'dd',
  'summary', 'figcaption', 'caption',
]);

const sanitizeSchema = (() => {
  const s = structuredClone(defaultSchema);
  s.attributes = s.attributes ?? {};
  s.attributes['*'] = [...(s.attributes['*'] ?? []), 'dataSp', 'dataCode', 'dataAtomic', 'dir'];
  s.attributes.code = [
    ...(s.attributes.code ?? []).filter((a) => !(Array.isArray(a) && a[0] === 'className')),
    ['className', /^language-./, 'math-inline', 'math-display'],
  ];
  s.attributes.div = [...(s.attributes.div ?? []), ['className', 'math-wrap']];
  s.attributes.span = [...(s.attributes.span ?? []), ['className', 'math-wrap']];
  return s;
})();

function headingText(node: Heading): string {
  let out = '';
  visit(node, (n) => {
    if (n.type === 'text' || n.type === 'inlineCode' || n.type === 'inlineMath') {
      out += (n as { value: string }).value;
    }
  });
  return out.trim();
}

/** Parse Markdown into its syntax tree (with positions). */
export function parseMarkdown(source: string): MdRoot {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter, ['yaml']).parse(source) as MdRoot;
}

export function buildOutline(tree: MdRoot, source: string): OutlineEntry[] {
  const slugger = new GithubSlugger();
  const entries: OutlineEntry[] = [];
  visit(tree, 'heading', (node: Heading) => {
    const p = node.position;
    if (!p || p.start.offset === undefined || p.end.offset === undefined) return;
    const text = headingText(node);
    entries.push({
      depth: node.depth,
      text,
      slug: slugger.slug(text || 'section'),
      start: p.start.offset,
      end: p.end.offset,
      sectionEnd: source.length,
      line: p.start.line,
    });
  });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j]!.depth <= e.depth) {
        e.sectionEnd = entries[j]!.start;
        break;
      }
    }
  }
  return entries;
}

export function buildBlocks(tree: MdRoot): BlockInfo[] {
  const blocks: BlockInfo[] = [];
  const walk = (node: MdNodes, depth: number) => {
    const p = node.position;
    if (BLOCK_KINDS.has(node.type) && p && p.start.offset !== undefined && p.end.offset !== undefined) {
      blocks.push({ kind: node.type as BlockKind, start: p.start.offset, end: p.end.offset, depth });
    }
    if ('children' in node) {
      for (const child of node.children as MdNodes[]) walk(child, depth + 1);
    }
  };
  for (const child of tree.children) walk(child, 1);
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  return blocks;
}

/** The chain of headings that contain `offset`, outermost first. */
export function headingPathAt(outline: OutlineEntry[], offset: number): OutlineEntry[] {
  const stack: OutlineEntry[] = [];
  for (const e of outline) {
    if (e.start > offset) break;
    while (stack.length && stack[stack.length - 1]!.depth >= e.depth) stack.pop();
    if (offset < e.sectionEnd) stack.push(e);
  }
  return stack.filter((e) => offset < e.sectionEnd);
}

function spOf(node: { position?: { start?: { offset?: number }; end?: { offset?: number } } }): string | null {
  const s = node.position?.start?.offset;
  const e = node.position?.end?.offset;
  if (s === undefined || e === undefined) return null;
  return `${s}:${e}`;
}

function hasClass(el: Element, cls: string): boolean {
  const c = el.properties?.className;
  return Array.isArray(c) && c.includes(cls);
}

/** rehype plugin: attach source offsets to every element and text run. */
function rehypeSourceMap(options: { source: string }) {
  const { source } = options;
  return (tree: HRoot) => {
    const transform = (parent: HRoot | Element, inPre: boolean) => {
      const next: ElementContent[] = [];
      const parentSp = 'position' in parent ? spOf(parent) : null;
      const [pStart, pEnd] = parentSp ? parentSp.split(':').map(Number) as [number, number] : [0, source.length];
      let cursor = pStart;
      for (const child of parent.children as ElementContent[]) {
        if (child.type === 'text') {
          let sp = spOf(child);
          if (!sp && !inPre && parentSp && child.value.trim()) {
            // Text that lost its position (e.g. merged by the raw-HTML pass):
            // locate it inside the parent's source span.
            const t = child.value.trim();
            const at = source.indexOf(t, cursor);
            if (at !== -1 && at + t.length <= pEnd) sp = `${at}:${at + t.length}`;
          }
          if (sp && !inPre && child.value.length > 0) {
            cursor = Number(sp.split(':')[1]);
            next.push({ type: 'element', tagName: 'span', properties: { dataSp: sp }, children: [child] });
          } else {
            next.push(child);
          }
          continue;
        }
        if (child.type !== 'element') {
          next.push(child);
          continue;
        }
        const el = child;
        const sp = spOf(el);
        const props: Properties = (el.properties = el.properties ?? {});
        if (sp) {
          props.dataSp = sp;
          cursor = Math.max(cursor, Number(sp.split(':')[1]));
        }
        if (DIR_AUTO_TAGS.has(el.tagName)) props.dir = 'auto';

        if (el.tagName === 'pre' && sp) {
          const code = el.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
          if (code && hasClass(code, 'math-display')) {
            props.dataAtomic = 'true';
            next.push({ type: 'element', tagName: 'div', properties: { className: ['math-wrap'], dataSp: sp, dataAtomic: 'true' }, children: [el] });
            continue;
          }
          const start = el.position!.start;
          const indent = (start.column ?? 1) - 1;
          const lineText = source.slice(start.offset!, start.offset! + 4);
          const frontmatter = hasClass(el, 'frontmatter');
          const fenced = frontmatter || /^(`{3,}|~{3,})/.test(lineText);
          const firstContentLine = fenced ? start.line + 1 : start.line;
          props.dataCode = `${firstContentLine}:${frontmatter ? 0 : fenced ? indent : indent + 4}`;
          transform(el, true);
          next.push(el);
          continue;
        }
        if (el.tagName === 'code' && hasClass(el, 'math-inline') && sp) {
          next.push({ type: 'element', tagName: 'span', properties: { className: ['math-wrap'], dataSp: sp, dataAtomic: 'true' }, children: [el] });
          continue;
        }
        transform(el, inPre);
        next.push(el);
      }
      parent.children = next as typeof parent.children;
    };
    transform(tree, false);
  };
}

const CALLOUTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

/** rehype plugin: GitHub alert syntax (> [!NOTE]) -> callout blocks. */
function rehypeCallouts() {
  return (tree: HRoot) => {
    visit(tree, 'element', (el: Element) => {
      if (el.tagName !== 'blockquote') return;
      const p = el.children.find((c): c is Element => c.type === 'element');
      if (!p || p.tagName !== 'p') return;
      const span = p.children[0];
      if (!span || span.type !== 'element' || span.tagName !== 'span') return;
      const text = span.children[0];
      if (!text || text.type !== 'text') return;
      const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n)?/i.exec(text.value);
      if (!m) return;
      const kind = m[1]!.toUpperCase();
      text.value = text.value.slice(m[0].length);
      const sp = String(span.properties?.dataSp ?? '');
      const [s, e] = sp.split(':').map(Number);
      if (s !== undefined && e !== undefined && !Number.isNaN(s)) {
        span.properties!.dataSp = `${s + m[0].length}:${e}`;
      }
      if (!text.value) p.children.shift();
      el.properties = { ...el.properties, className: ['callout', `callout-${kind.toLowerCase()}`] };
      el.children.unshift({
        type: 'element',
        tagName: 'div',
        properties: { className: ['callout-title'], dataAtomic: 'true' },
        children: [{ type: 'text', value: CALLOUTS[kind]! }],
      });
    });
  };
}

/** rehype plugin: heading ids, safe links, remote images. */
function rehypeFinalize(options: { outline: OutlineEntry[]; baseUrl?: string; remoteImages: string[] }) {
  const byStart = new Map(options.outline.map((e) => [e.start, e]));
  return (tree: HRoot) => {
    visit(tree, 'element', (el: Element) => {
      const props = (el.properties = el.properties ?? {});
      if (/^h[1-6]$/.test(el.tagName)) {
        const start = Number(String(props.dataSp ?? '').split(':')[0]);
        const entry = byStart.get(start);
        if (entry) props.id = `h-${entry.slug}`;
      }
      if (el.tagName === 'a' && typeof props.href === 'string') {
        const href = props.href;
        if (!href.startsWith('#')) {
          const resolved = resolveUrl(href, options.baseUrl);
          if (resolved) {
            props.href = resolved;
            props.target = '_blank';
            props.rel = ['noopener', 'noreferrer'];
          } else {
            delete props.href;
          }
        }
      }
      if (el.tagName === 'img' && typeof props.src === 'string') {
        const src = props.src;
        if (src.startsWith('data:image/') && !src.startsWith('data:image/svg')) return;
        const resolved = resolveUrl(src, options.baseUrl);
        delete props.src;
        if (resolved && /^https?:/.test(resolved)) {
          props.dataRemoteSrc = resolved;
          options.remoteImages.push(resolved);
        }
      }
    });
    return tree;
  };
}

export function resolveUrl(href: string, baseUrl?: string): string | null {
  try {
    const u = baseUrl ? new URL(href, baseUrl) : new URL(href);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.href;
    if (u.protocol === 'file:' && baseUrl?.startsWith('file:')) return u.href;
    return null;
  } catch {
    return null;
  }
}

/** Render Markdown source into a sanitised hast tree with a source map. */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const mdast = parseMarkdown(source);
  const outline = buildOutline(mdast, source);
  const blocks = buildBlocks(mdast);
  const remoteImages: string[] = [];

  const processor = unified()
    .use(remarkRehype, {
      allowDangerousHtml: true,
      handlers: {
        yaml(state, node) {
          const result: Element = {
            type: 'element',
            tagName: 'pre',
            properties: { className: ['frontmatter'] },
            children: [
              {
                type: 'element',
                tagName: 'code',
                properties: { className: ['language-yaml'] },
                children: [{ type: 'text', value: String((node as { value: string }).value) }],
              },
            ],
          };
          state.patch(node, result);
          return result;
        },
      },
    })
    .use(rehypeRaw)
    .use(rehypeSourceMap, { source })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeCallouts)
    .use(rehypeKatex, { throwOnError: false, strict: false, trust: false, output: 'htmlAndMathml' })
    .use(rehypeFinalize, { outline, baseUrl: options.baseUrl, remoteImages });

  // structuredClone keeps the parsed tree untouched (runSync mutates in place).
  const hast = processor.runSync(structuredClone(mdast) as never) as unknown as HRoot;
  return { hast, outline, blocks, remoteImages };
}

export type { HText };
export { SKIP };
