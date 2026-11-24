// Turns Google exports into Markdown that the viewer can show and anchor:
// Docs (Markdown export), Sheets (xlsx or CSV) and Slides (pptx or text).
// Pure functions: same bytes in, same Markdown out. XML is read with the
// browser's DOMParser as data only; nothing in a file is executed.

import { unzipSync, strFromU8 } from 'fflate';
import type { Anchor } from '../types';

export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEET_COLS = 104;
const MAX_UNZIPPED = 80 * 1024 * 1024;

// ---------- Docs ----------

/**
 * Google's Markdown export embeds images as huge base64 data. They can't be
 * shown safely anyway (the sanitizer only allows http(s) images), so they are
 * replaced by a short placeholder, which keeps line numbers small and stable.
 */
export function cleanDocsMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^(\s*\[[^\]\n]+\]:\s*)<?data:[^\s>]+>?/gm, '$1#image-not-shown')
    .replace(/!\[([^\]\n]*)\]\(<?data:[^)\s>]+>?\)/g, '![$1](#image-not-shown)');
}

/** Plain-text export of a Doc: kept as is, with a note that formatting is missing. */
export function docsTextToMarkdown(txt: string): string {
  return txt.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// ---------- Sheets ----------

export function columnName(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function columnIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(v: string): string {
  return v.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>').trim();
}

/** One sheet as a Markdown table: a "Row" column with sheet row numbers, and column letters as headers. */
function sheetTable(rows: Map<number, Map<number, string>>, note: string[]): string {
  let maxRow = 0;
  let maxCol = -1;
  for (const [r, cols] of rows)
    for (const [c, v] of cols)
      if (v.trim()) {
        maxRow = Math.max(maxRow, r);
        maxCol = Math.max(maxCol, c);
      }
  if (maxCol < 0) return '_This sheet is empty._\n';
  if (maxRow > MAX_SHEET_ROWS) {
    note.push(`Only the first ${MAX_SHEET_ROWS.toLocaleString('en-US')} rows are shown.`);
    maxRow = MAX_SHEET_ROWS;
  }
  if (maxCol >= MAX_SHEET_COLS) {
    note.push(`Only columns A to ${columnName(MAX_SHEET_COLS - 1)} are shown.`);
    maxCol = MAX_SHEET_COLS - 1;
  }
  const cols = Array.from({ length: maxCol + 1 }, (_, i) => columnName(i));
  const out = [`| Row | ${cols.join(' | ')} |`, `| ---: | ${cols.map(() => '---').join(' | ')} |`];
  for (let r = 1; r <= maxRow; r++) {
    const row = rows.get(r);
    if (!row || ![...row.values()].some((v) => v.trim())) continue;
    out.push(`| ${r} | ${cols.map((_, c) => cellText(row.get(c) ?? '')).join(' | ')} |`);
  }
  return out.join('\n') + '\n';
}

/** Parses CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function csvToMarkdown(csv: string, title: string, sheetName = 'Sheet'): string {
  const rows = new Map<number, Map<number, string>>();
  parseCsv(csv).forEach((cells, r) => rows.set(r + 1, new Map(cells.map((v, c) => [c, v]))));
  const note: string[] = [];
  const table = sheetTable(rows, note);
  const lines = [`# ${title}`, '', `_Google Sheets, one tab only (CSV export). Formulas are not included._`, '', `## Sheet: ${sheetName}`, ''];
  if (note.length) lines.push(`_${note.join(' ')}_`, '');
  lines.push(table);
  return lines.join('\n');
}

type Files = Record<string, Uint8Array>;

function unzip(bytes: Uint8Array): Files {
  let total = 0;
  return unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error('This file is too large to open.');
      return f.name.endsWith('.xml') || f.name.endsWith('.rels');
    },
  });
}

function xml(files: Files, path: string): Document | null {
  const f = files[path];
  if (!f) return null;
  const doc = new DOMParser().parseFromString(strFromU8(f), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

function byLocal(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function childrenByLocal(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}

/** The r:id attribute (relationship id). Slide entries also have a plain "id", which is something else. */
function relId(el: Element): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === 'id' && (a.prefix === 'r' || (a.namespaceURI ?? '').includes('relationships'))) return a.value;
  return null;
}

/** Relationship id → target path (resolved against the folder of the part). */
function rels(files: Files, partPath: string): Map<string, { target: string; type: string }> {
  const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1);
  const relsPath = `${dir}_rels/${partPath.slice(dir.length)}.rels`;
  const doc = xml(files, relsPath);
  const out = new Map<string, { target: string; type: string }>();
  if (!doc) return out;
  for (const r of byLocal(doc, 'Relationship')) {
    const id = r.getAttribute('Id');
    const t = r.getAttribute('Target');
    if (!id || !t) continue;
    out.set(id, { target: resolvePath(dir, t), type: r.getAttribute('Type') ?? '' });
  }
  return out;
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyles(files: Files): Set<number> {
  const doc = xml(files, 'xl/styles.xml');
  const out = new Set<number>();
  if (!doc) return out;
  const custom = new Map<number, string>();
  for (const f of byLocal(doc, 'numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
  const xfs = byLocal(doc, 'cellXfs')[0];
  if (!xfs) return out;
  childrenByLocal(xfs, 'xf').forEach((xf, i) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0);
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (BUILTIN_DATE_FORMATS.has(id) || /[dmyhs]/i.test(code)) out.add(i);
  });
  return out;
}

/** Spreadsheet serial day number → ISO date (and time, when it has one). */
export function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return String(Number(n.toPrecision(15)));
}

function richText(si: Element): string {
  return byLocal(si, 't')
    .filter((t) => t.parentElement?.localName !== 'rPh')
    .map((t) => t.textContent ?? '')
    .join('');
}

export function xlsxToMarkdown(bytes: Uint8Array, title: string): string {
  const files = unzip(bytes);
  const wb = xml(files, 'xl/workbook.xml');
  if (!wb) throw new Error('This is not a readable spreadsheet.');
  const wbRels = rels(files, 'xl/workbook.xml');
  const sst = xml(files, 'xl/sharedStrings.xml');
  const shared = sst ? byLocal(sst, 'si').map(richText) : [];
  const dates = dateStyles(files);

  const lines = [`# ${title}`, '', '_Google Sheets. Each tab is a section; the Row column and the column letters match the sheet, so a comment can name its cell (for example B7)._', ''];
  for (const sheet of byLocal(wb, 'sheet')) {
    const name = sheet.getAttribute('name') ?? 'Sheet';
    const rid = relId(sheet);
    const target = rid ? wbRels.get(rid)?.target : undefined;
    const doc = target ? xml(files, target) : null;
    const hidden = sheet.getAttribute('state') === 'hidden' || sheet.getAttribute('state') === 'veryHidden';
    lines.push(`## Sheet: ${name}${hidden ? ' (hidden)' : ''}`, '');
    if (!doc) {
      lines.push('_This tab could not be read._', '');
      continue;
    }
    const rows = new Map<number, Map<number, string>>();
    const formulas: string[] = [];
    let nextRow = 1;
    for (const row of byLocal(doc, 'row')) {
      const r = Number(row.getAttribute('r') ?? nextRow);
      nextRow = r + 1;
      const cells = new Map<number, string>();
      let nextCol = 0;
      for (const c of childrenByLocal(row, 'c')) {
        const ref = c.getAttribute('r');
        const col = ref ? columnIndex(ref.replace(/\d+$/, '')) : nextCol;
        nextCol = col + 1;
        const t = c.getAttribute('t');
        const v = childrenByLocal(c, 'v')[0]?.textContent ?? '';
        const f = childrenByLocal(c, 'f')[0]?.textContent;
        let text: string;
        if (t === 's') text = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') text = childrenByLocal(c, 'is').map(richText).join('');
        else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'str' || t === 'e') text = v;
        else if (v !== '' && dates.has(Number(c.getAttribute('s') ?? -1))) text = serialToDate(Number(v));
        else text = v === '' ? '' : formatNumber(v);
        cells.set(col, text);
        if (f && r <= MAX_SHEET_ROWS) formulas.push(`- ${columnName(col)}${r}: \`=${f.replace(/`/g, "'")}\``);
      }
      rows.set(r, cells);
    }
    const note: string[] = [];
    const table = sheetTable(rows, note);
    if (note.length) lines.push(`_${note.join(' ')}_`, '');
    lines.push(table);
    if (formulas.length) {
      lines.push(`### Formulas in ${name}`, '', ...formulas.slice(0, 2000), '');
      if (formulas.length > 2000) lines.push(`_${formulas.length - 2000} more formulas are not listed._`, '');
    }
  }
  return lines.join('\n');
}

/**
 * The cell a comment points at, for prompts about Google Sheets
 * ("Budget!B7", or "Budget!B7:C9" for a range). Works on the Markdown
 * produced above: the section heading names the tab, the first column holds
 * the row number, and pipes separate the columns.
 */
export function sheetCellRef(source: string, anchor: Pick<Anchor, 'start' | 'end' | 'headingPath'>): string | null {
  const heading = anchor.headingPath.find((h) => h.startsWith('Sheet: '));
  if (!heading) return null;
  const sheet = heading.slice(7).replace(/ \(hidden\)$/, '');
  const at = (offset: number): string | null => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    const lineEnd = source.indexOf('\n', offset);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const m = /^\| (\d+) \|/.exec(line);
    if (!m) return null;
    let pipes = 0;
    for (let i = 0; i < offset - lineStart; i++) {
      if (line[i] === '\\') i++;
      else if (line[i] === '|') pipes++;
    }
    const col = pipes - 2;
    return col >= 0 ? `${columnName(col)}${m[1]}` : null;
  };
  const a = at(anchor.start);
  if (!a) return null;
  const b = at(Math.max(anchor.start, anchor.end - 1));
  const quoted = /^[A-Za-z0-9_]+$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  return b && b !== a ? `${quoted}!${a}:${b}` : `${quoted}!${a}`;
}

// ---------- Slides ----------

function paragraphs(body: Element): { text: string; level: number }[] {
  return byLocal(body, 'p')
    .map((p) => {
      const lvl = Number(byLocal(p, 'pPr')[0]?.getAttribute('lvl') ?? 0);
      const text = Array.from(p.getElementsByTagNameNS('*', '*'))
        .filter((n) => n.localName === 't' || n.localName === 'br')
        .map((n) => (n.localName === 'br' ? ' ' : (n.textContent ?? '')))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      return { text, level: Math.min(Math.max(lvl, 0), 6) };
    })
    .filter((p) => p.text);
}

function mdInline(s: string): string {
  return s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

function placeholderType(sp: Element): string | null {
  const ph = byLocal(sp, 'ph')[0];
  return ph ? (ph.getAttribute('type') ?? 'body') : null;
}

export function pptxToMarkdown(bytes: Uint8Array, title: string): string {
  const files = unzip(bytes);
  const pres = xml(files, 'ppt/presentation.xml');
  if (!pres) throw new Error('This is not a readable presentation.');
  const presRels = rels(files, 'ppt/presentation.xml');
  const lines = [`# ${title}`, '', '_Google Slides. Each slide is a section; speaker notes are quoted under it._', ''];
  let n = 0;
  for (const s of byLocal(pres, 'sldId')) {
    const rid = relId(s);
    const target = rid ? presRels.get(rid)?.target : undefined;
    const doc = target ? xml(files, target) : null;
    n++;
    if (!doc || !target) {
      lines.push(`## Slide ${n}`, '', '_This slide could not be read._', '');
      continue;
    }
    let slideTitle = '';
    const body: string[] = [];
    for (const sp of byLocal(doc, 'sp')) {
      const tx = byLocal(sp, 'txBody')[0];
      if (!tx) continue;
      const type = placeholderType(sp);
      const paras = paragraphs(tx);
      if (!paras.length) continue;
      if ((type === 'title' || type === 'ctrTitle') && !slideTitle) {
        slideTitle = paras.map((p) => p.text).join(' ');
        continue;
      }
      if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
      for (const p of paras) body.push(`${'  '.repeat(p.level)}- ${mdInline(p.text)}`);
    }
    for (const tbl of byLocal(doc, 'tbl')) {
      const rows = byLocal(tbl, 'tr').map((tr) => byLocal(tr, 'tc').map((tc) => cellText(paragraphs(tc).map((p) => p.text).join(' '))));
      const width = Math.max(0, ...rows.map((r) => r.length));
      if (!width) continue;
      body.push('');
      rows.forEach((r, i) => {
        body.push(`| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`);
        if (i === 0) body.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
      });
      body.push('');
    }
    lines.push(slideTitle ? `## Slide ${n}: ${mdInline(slideTitle)}` : `## Slide ${n}`, '');
    if (body.length) lines.push(...body, '');
    else lines.push('_No text on this slide._', '');
    // Speaker notes
    const notesRel = [...rels(files, target).values()].find((r) => r.type.endsWith('/notesSlide'));
    const notes = notesRel ? xml(files, notesRel.target) : null;
    if (notes) {
      const text = byLocal(notes, 'sp')
        .filter((sp) => placeholderType(sp) === 'body')
        .flatMap((sp) => paragraphs(byLocal(sp, 'txBody')[0] ?? sp).map((p) => p.text));
      if (text.length) lines.push(`> **Speaker notes:** ${mdInline(text.join(' '))}`, '');
    }
  }
  if (n === 0) lines.push('_This presentation has no slides._', '');
  return lines.join('\n');
}

/** Plain-text export of Slides, used when the pptx export is unavailable. */
export function slidesTextToMarkdown(txt: string, title: string): string {
  const body = txt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  return [`# ${title}`, '', '_Google Slides, plain text export: slide boundaries and speaker notes are not available._', '', body, ''].join('\n');
}
