// Renders the sanitised hast tree as React elements. No innerHTML is used for
// document content; only Mermaid's own sanitised SVG output is injected.

import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import type { Element, Root } from 'hast';
import { highlight, normaliseLang } from '../lib/highlight';

interface Props {
  hast: Root;
  dark: boolean;
  allowRemoteImages: boolean;
  onLoadImages: () => void;
  /** Called whenever rendered text nodes change (highlighting, diagrams). */
  onContentChange: () => void;
}

function codeOf(node: Element): { code: string; lang: string | undefined } {
  const codeEl = node.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  const classes = (codeEl?.properties?.className as string[] | undefined) ?? [];
  const lang = classes.find((c) => c.startsWith('language-'))?.slice(9);
  let code = '';
  const walk = (n: Element | Root) => {
    for (const c of n.children) {
      if (c.type === 'text') code += c.value;
      else if (c.type === 'element') walk(c);
    }
  };
  if (codeEl) walk(codeEl);
  return { code, lang };
}

interface Ctx {
  dark: boolean;
  allowRemoteImages: boolean;
  onLoadImages: () => void;
  onContentChange: () => void;
}

// Dynamic values reach the block components through context, so the component
// functions themselves stay stable and React never remounts them.
const MdContext = createContext<Ctx>({ dark: false, allowRemoteImages: false, onLoadImages: () => {}, onContentChange: () => {} });

function CodeBlock({ node }: { node: Element }) {
  const { onContentChange } = useContext(MdContext);
  const { code, lang } = codeOf(node);
  const text = code.endsWith('\n') ? code.slice(0, -1) : code;
  const [tree, setTree] = useState<Root | null>(null);
  const sp = node.properties?.dataSp as string | undefined;
  const dc = node.properties?.dataCode as string | undefined;

  useEffect(() => {
    let alive = true;
    highlight(text, lang)
      .then((t) => {
        if (alive && t) setTree(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [text, lang]);

  useEffect(() => {
    if (tree) onContentChange();
  }, [tree, onContentChange]);

  let inner: React.ReactNode = <code>{text}</code>;
  if (tree) {
    const pre = tree.children[0] as Element | undefined;
    const codeEl = pre?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
    if (codeEl) {
      inner = toJsxRuntime({ type: 'root', children: [codeEl] }, { Fragment, jsx, jsxs }) as React.ReactNode;
    }
  }
  const label = normaliseLang(lang) ?? lang;
  return (
    <div className="code-block">
      {label ? <span className="lang-tag" aria-hidden="true">{label}</span> : null}
      <pre data-sp={sp} data-code={dc} className={tree ? 'shiki' : undefined}>
        {inner}
      </pre>
    </div>
  );
}

let mermaidSeq = 0;

function MermaidBlock({ node }: { node: Element }) {
  const { dark, onContentChange } = useContext(MdContext);
  const { code } = codeOf(node);
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const sp = node.properties?.dataSp as string | undefined;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' });
        const { svg } = await mermaid.render(`rp-mermaid-${++mermaidSeq}`, code);
        if (alive && ref.current) {
          // Mermaid's strict mode sanitises the SVG with DOMPurify before returning it.
          ref.current.innerHTML = svg;
          setError(null);
          onContentChange();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message.split('\n')[0]! : 'Could not draw this diagram.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, dark, onContentChange]);

  return (
    <div className="mermaid-block" data-sp={sp} data-atomic="true" role="img" aria-label="Mermaid diagram">
      <div ref={ref} />
      {error ? (
        <>
          <pre style={{ textAlign: 'start' }}><code>{code}</code></pre>
          <div className="mermaid-error">Diagram error: {error}</div>
        </>
      ) : null}
    </div>
  );
}

function RemoteImage({ node }: { node: Element }) {
  const { allowRemoteImages: allow, onLoadImages: onLoad } = useContext(MdContext);
  const src = node.properties?.dataRemoteSrc as string | undefined;
  const alt = (node.properties?.alt as string | undefined) ?? '';
  const sp = node.properties?.dataSp as string | undefined;
  if (src && allow) return <img src={src} alt={alt} data-sp={sp} referrerPolicy="no-referrer" loading="lazy" />;
  let host = '';
  try {
    host = src ? new URL(src).host : '';
  } catch {
    host = '';
  }
  return (
    <span className="remote-image" data-sp={sp} data-atomic="true">
      <span aria-hidden="true">▣</span>
      <span>
        {alt || 'Image'}
        {host ? <span style={{ color: 'var(--text-3)' }}> · {host}</span> : null}
      </span>
      {src ? (
        <button type="button" className="btn btn-ghost btn-xs" onClick={onLoad} title="Images from the web are blocked until you allow them, so the page makes no network requests by default.">
          Load images
        </button>
      ) : null}
    </span>
  );
}

const components = {
  pre: (props: { node?: Element }) => {
    const node = props.node!;
    const { lang } = codeOf(node);
    if (lang === 'mermaid') return <MermaidBlock node={node} />;
    return <CodeBlock node={node} />;
  },
  img: (props: { node?: Element; src?: string; alt?: string }) => {
    const node = props.node!;
    if (node.properties?.dataRemoteSrc) return <RemoteImage node={node} />;
    if (!props.src) return <span className="remote-image" data-atomic="true">{props.alt || 'Image'}</span>;
    return <img src={props.src} alt={props.alt ?? ''} data-sp={node.properties?.dataSp as string | undefined} />;
  },
  input: (props: { checked?: boolean }) => <input type="checkbox" checked={Boolean(props.checked)} readOnly disabled data-atomic="true" />,
};

const Tree = memo(function Tree({ hast }: { hast: Root }) {
  return toJsxRuntime(hast, { Fragment, jsx, jsxs, passNode: true, components }) as React.ReactElement;
});

function MarkdownViewImpl({ hast, dark, allowRemoteImages, onLoadImages, onContentChange }: Props) {
  return (
    <MdContext.Provider value={{ dark, allowRemoteImages, onLoadImages, onContentChange }}>
      <Tree hast={hast} />
    </MdContext.Provider>
  );
}

export const MarkdownView = memo(MarkdownViewImpl);
