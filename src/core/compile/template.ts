// A tiny, logic-less template engine for custom prompt templates.
// It never uses eval or new Function (Chrome forbids both in extensions),
// and output is fully deterministic.
//
// Syntax:
//   {{path.to.value}}                 insert a value
//   {{#each items}} ... {{/each}}     loop; inside, {{this}}, {{@index}} (0-based), {{@number}} (1-based)
//   {{#if path}} ... {{else}} ... {{/if}}
//   {{#unless path}} ... {{/unless}}
//   {{fence path}}                    value inside a Markdown code fence that cannot break
//   {{join path ", "}}                join an array
//   {{! comment }}

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; path: string }
  | { t: 'fence'; path: string }
  | { t: 'join'; path: string; sep: string }
  | { t: 'each'; path: string; body: Node[] }
  | { t: 'if'; path: string; neg: boolean; body: Node[]; alt: Node[] };

export class TemplateError extends Error {}

const TAG = /\{\{\s*([\s\S]*?)\s*\}\}/g;

export function parseTemplate(src: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: 'each' | 'if' }> | null; list: Node[]; inAlt: boolean }[] = [
    { node: null, list: root, inAlt: false },
  ];
  let last = 0;
  const top = () => stack[stack.length - 1]!;
  const emit = (n: Node) => {
    const f = top();
    if (f.node?.t === 'if' && f.inAlt) f.node.alt.push(n);
    else f.list.push(n);
  };
  for (const m of src.matchAll(TAG)) {
    if (m.index! > last) emit({ t: 'text', v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const tag = m[1]!;
    if (tag.startsWith('!')) continue;
    if (tag.startsWith('#each ')) {
      const n: Node = { t: 'each', path: tag.slice(6).trim(), body: [] };
      emit(n);
      stack.push({ node: n, list: n.body, inAlt: false });
    } else if (tag.startsWith('#if ') || tag.startsWith('#unless ')) {
      const neg = tag.startsWith('#unless ');
      const n: Node = { t: 'if', path: tag.slice(neg ? 8 : 4).trim(), neg, body: [], alt: [] };
      emit(n);
      stack.push({ node: n, list: n.body, inAlt: false });
    } else if (tag === 'else') {
      const f = top();
      if (f.node?.t !== 'if') throw new TemplateError('{{else}} without {{#if}}');
      f.inAlt = true;
    } else if (tag === '/each' || tag === '/if' || tag === '/unless') {
      const f = stack.pop();
      const want = tag === '/each' ? 'each' : 'if';
      if (!f || !f.node || f.node.t !== want) throw new TemplateError(`Unexpected {{${tag}}}`);
    } else if (tag.startsWith('fence ')) {
      emit({ t: 'fence', path: tag.slice(6).trim() });
    } else if (tag.startsWith('join ')) {
      const mm = /^join\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$/.exec(tag);
      if (!mm) throw new TemplateError('Use {{join path ", "}}');
      emit({ t: 'join', path: mm[1]!, sep: JSON.parse(`"${mm[2]}"`) as string });
    } else if (/^[@\w.]+$/.test(tag)) {
      emit({ t: 'var', path: tag });
    } else {
      throw new TemplateError(`Unknown tag {{${tag}}}`);
    }
  }
  if (last < src.length) emit({ t: 'text', v: src.slice(last) });
  if (stack.length !== 1) throw new TemplateError('A block was opened but never closed');
  return root;
}

type Scope = { data: unknown; locals: Record<string, unknown>; parent: Scope | null };

function lookup(scope: Scope, path: string): unknown {
  if (path === 'this') return scope.data;
  if (path.startsWith('@')) {
    for (let s: Scope | null = scope; s; s = s.parent) if (path in s.locals) return s.locals[path];
    return undefined;
  }
  const parts = path.replace(/^this\./, '').split('.');
  for (let s: Scope | null = scope; s; s = s.parent) {
    let v: unknown = s.data;
    let ok = true;
    for (const p of parts) {
      if (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, p)) v = (v as Record<string, unknown>)[p];
      else {
        ok = false;
        break;
      }
    }
    if (ok) return v;
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function fence(text: string, info = ''): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}

function run(nodes: Node[], scope: Scope): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        out += n.v;
        break;
      case 'var':
        out += str(lookup(scope, n.path));
        break;
      case 'fence':
        out += fence(str(lookup(scope, n.path)), 'text');
        break;
      case 'join': {
        const v = lookup(scope, n.path);
        out += Array.isArray(v) ? v.map(str).join(n.sep) : str(v);
        break;
      }
      case 'each': {
        const v = lookup(scope, n.path);
        if (Array.isArray(v)) {
          v.forEach((item, i) => {
            out += run(n.body, { data: item, locals: { '@index': i, '@number': i + 1, '@last': i === v.length - 1 }, parent: scope });
          });
        }
        break;
      }
      case 'if': {
        const ok = truthy(lookup(scope, n.path)) !== n.neg;
        out += run(ok ? n.body : n.alt, scope);
        break;
      }
    }
  }
  return out;
}

export function renderTemplate(src: string, data: unknown): string {
  return run(parseTemplate(src), { data, locals: {}, parent: null });
}
