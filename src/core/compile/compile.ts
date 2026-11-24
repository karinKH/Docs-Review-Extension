// Deterministic prompt compiler: the same session and options always produce
// byte-identical output. No dates, no randomness, stable ordering.

import { sheetCellRef } from '../google/convert';
import YAML from 'yaml';
import {
  INTENT_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  type Annotation,
  type Intent,
  type Priority,
  type Session,
  type Status,
} from '../types';
import { countOccurrences } from '../anchor/anchor';
import { LineIndex } from '../text/lines';
import { inDocumentOrder, referencedNumbers } from '../session';
import { fence, renderTemplate } from './template';
import { approxTokens } from './tokens';

export type PresetId = 'agent' | 'chat' | 'json' | 'yaml' | 'custom';

export const PRESET_LABELS: Record<PresetId, string> = {
  agent: 'Coding agent (Markdown)',
  chat: 'Chat assistant (XML)',
  json: 'JSON',
  yaml: 'YAML',
  custom: 'Custom template',
};

export interface CompileOptions {
  preset: PresetId;
  customTemplate?: string;
  statuses: Status[];
  priorities: Priority[];
  /** Only items under these top-level sections (null = all). */
  sections: string[] | null;
  order: 'document' | 'priority';
  /** Chat preset: return the whole document or only the changed passages. */
  chatOutput: 'full' | 'changes';
  /** Chat preset: paste the document itself into the prompt. */
  includeDocument: boolean;
  /** Approximate token budget per part; null = one part. */
  maxTokensPerPart: number | null;
}

export const DEFAULT_OPTIONS: CompileOptions = {
  preset: 'agent',
  statuses: ['open', 'retry'],
  priorities: ['must', 'suggestion', 'nit'],
  sections: null,
  order: 'document',
  chatOutput: 'full',
  includeDocument: false,
  maxTokensPerPart: null,
};

const BLOCK_LABELS: Record<string, string> = {
  heading: 'heading',
  paragraph: 'paragraph',
  listItem: 'list item',
  list: 'list',
  blockquote: 'quote',
  code: 'code block',
  math: 'formula',
  table: 'table',
  tableRow: 'table row',
  tableCell: 'table cell',
  html: 'HTML block',
  yaml: 'front matter',
  footnoteDefinition: 'footnote',
};

const LONG_QUOTE = 1500;
const EXCERPT = 300;

export interface ItemView {
  number: number;
  intent: Intent;
  intentLabel: string;
  priority: Priority;
  priorityLabel: string;
  mode: 'instruction' | 'replace';
  isReplace: boolean;
  status: Status;
  /** Asked for in an earlier round but not applied correctly. */
  isRetry: boolean;
  /** What the AI said about this item last time, if pasted back. */
  aiReply: string;
  startLine: number;
  endLine: number;
  lines: string;
  headingPath: string[];
  section: string;
  topSection: string;
  block: string;
  blockOrdinal: number | null;
  location: string;
  original: string;
  originalForDisplay: string;
  isExcerpt: boolean;
  prefix: string;
  suffix: string;
  occurrences: number;
  ambiguous: boolean;
  instruction: string;
  replacement: string;
  references: number[];
}

export interface DocView {
  title: string;
  path: string;
  lineCount: number;
  fingerprint: string;
}

export interface PromptModel {
  doc: DocView;
  directives: string[];
  items: ItemView[];
  counts: { total: number; must: number; suggestion: number; nit: number };
  part: { index: number; total: number; sections: string[] } | null;
  source: string;
}

export interface CompiledPart {
  text: string;
  itemCount: number;
  sections: string[];
  approxTokens: number;
}

export interface CompileResult {
  parts: CompiledPart[];
  itemCount: number;
}

function lineLabel(a: number, b: number): string {
  return a === b ? `line ${a}` : `lines ${a}-${b}`;
}

function toItem(a: Annotation, source: string): ItemView {
  const an = a.anchor;
  const section = an.headingPath.length ? an.headingPath.join(' > ') : '(before the first heading)';
  const block = BLOCK_LABELS[an.blockKind] ?? (an.blockKind === 'document' ? 'document' : an.blockKind);
  const parts = [lineLabel(an.startLine, an.endLine), `section: ${section}`];
  const cell = sheetCellRef(source, an);
  if (cell) parts.push(`cell ${cell}`);
  if (an.scope === 'section') parts.push('whole section');
  else if (an.scope === 'document') parts.push('whole document');
  else if (an.blockOrdinal && an.blockKind !== 'document' && an.blockKind !== 'heading') parts.push(`${block} ${an.blockOrdinal} of its section`);
  else if (an.blockKind === 'heading') parts.push('heading');
  const occurrences = countOccurrences(source, an.exact);
  const isLong = a.mode === 'instruction' && an.exact.length > LONG_QUOTE;
  const instruction = a.body.trim() || (a.intent === 'delete' ? 'Delete this text.' : '');
  return {
    number: a.number,
    intent: a.intent,
    intentLabel: a.mode === 'replace' ? 'Exact replacement' : INTENT_LABELS[a.intent],
    priority: a.priority,
    priorityLabel: PRIORITY_LABELS[a.priority],
    mode: a.mode,
    isReplace: a.mode === 'replace',
    status: a.status,
    isRetry: a.status === 'retry',
    aiReply: a.aiReply ?? '',
    startLine: an.startLine,
    endLine: an.endLine,
    lines: an.startLine === an.endLine ? `${an.startLine}` : `${an.startLine}-${an.endLine}`,
    headingPath: an.headingPath,
    section,
    topSection: an.headingPath[0] ?? '(before the first heading)',
    block,
    blockOrdinal: an.blockOrdinal,
    location: parts.join(' · '),
    original: an.exact,
    originalForDisplay: isLong ? `${an.exact.slice(0, EXCERPT)}\n[... ${an.exact.length - 2 * EXCERPT} characters omitted ...]\n${an.exact.slice(-EXCERPT)}` : an.exact,
    isExcerpt: isLong,
    prefix: an.prefix,
    suffix: an.suffix,
    occurrences,
    ambiguous: occurrences > 1,
    instruction,
    replacement: a.replacement,
    references: referencedNumbers(a.body),
  };
}

export function buildModel(session: Session, options: CompileOptions): PromptModel {
  const lines = new LineIndex(session.source);
  let list = session.annotations.filter((a) => options.statuses.includes(a.status) && options.priorities.includes(a.priority));
  if (options.sections) {
    const set = new Set(options.sections);
    list = list.filter((a) => set.has(a.anchor.headingPath[0] ?? '(before the first heading)'));
  }
  list = inDocumentOrder(list);
  if (options.order === 'priority') {
    const rank = (p: Priority) => PRIORITIES.indexOf(p);
    list = [...list].sort((a, b) => rank(a.priority) - rank(b.priority) || a.anchor.start - b.anchor.start || a.number - b.number);
  }
  const items = list.map((a) => toItem(a, session.source));
  return {
    doc: {
      title: session.title,
      path: session.filePath || session.title,
      lineCount: lines.lineCount,
      fingerprint: session.sourceFingerprint,
    },
    directives: session.directives.map((d) => d.trim()).filter(Boolean),
    items,
    counts: {
      total: items.length,
      must: items.filter((i) => i.priority === 'must').length,
      suggestion: items.filter((i) => i.priority === 'suggestion').length,
      nit: items.filter((i) => i.priority === 'nit').length,
    },
    part: null,
    source: session.source,
  };
}

// ---------- presets ----------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function partLine(m: PromptModel): string {
  if (!m.part || m.part.total <= 1) return '';
  return `This is part ${m.part.index} of ${m.part.total}. It covers: ${m.part.sections.join('; ')}. Apply only the items in this part; the other parts will follow.\n\n`;
}

function agentPreset(m: PromptModel): string {
  const path = m.doc.path;
  const out: string[] = [];
  out.push(`# Revision request for \`${path}\``);
  out.push('');
  out.push(`${partLine(m)}Apply the ${plural(m.items.length, 'numbered change')} below to \`${path}\`.`);
  out.push('');
  out.push('## Rules');
  out.push('');
  out.push('1. Change only the text identified in each item. Leave everything else in the file exactly as it is, including formatting, whitespace and line breaks.');
  out.push(`2. Find each target by its quoted original text. Line numbers refer to the file as reviewed (${m.doc.lineCount} lines). If lines have shifted, trust the quote, not the line number.`);
  out.push('3. If a quote appears more than once, use the occurrence surrounded by the given "text before" and "text after".');
  out.push('4. "Exact replacement" items are literal: replace the original text with the replacement text character for character. Do not rephrase them.');
  out.push("5. All other items need your judgment. Apply them only to the quoted text unless the item says otherwise. Keep the document's language, tone and Markdown style.");
  out.push('6. "Question - do not edit" items need an answer only. Do not change the file for them.');
  out.push('7. References such as #3 point to other items in this list.');
  out.push('8. When you finish, reply with one line per item: "#<n> done", "#<n> skipped: <reason>" or "#<n> answer: <answer>".');
  if (m.directives.length) {
    out.push('');
    out.push('## Document-wide instructions');
    out.push('');
    for (const d of m.directives) out.push(`- ${d}`);
  }
  out.push('');
  out.push('## Changes');
  for (const it of m.items) {
    out.push('');
    out.push(`### #${it.number} · ${it.intentLabel} · ${it.priorityLabel}`);
    out.push('');
    out.push(`Location: ${it.location}`);
    out.push('');
    if (it.isReplace) {
      out.push('Replace this text:');
      out.push(fence(it.original, 'text'));
      out.push('With this text:');
      out.push(fence(it.replacement, 'text'));
    } else {
      out.push(it.isExcerpt ? `Original text (excerpt; the item covers all of ${lineLabel(it.startLine, it.endLine)}):` : 'Original text:');
      out.push(fence(it.originalForDisplay, 'text'));
    }
    if (it.ambiguous) {
      out.push(`This text appears ${it.occurrences} times. Use the occurrence between:`);
      out.push('Text before:');
      out.push(fence(it.prefix, 'text'));
      out.push('Text after:');
      out.push(fence(it.suffix, 'text'));
    }
    if (it.isReplace) {
      if (it.instruction) out.push(`Note: ${it.instruction}`);
    } else {
      out.push(`Instruction: ${it.instruction}`);
    }
    if (it.isRetry) out.push(`Second attempt: this change was requested before and was not applied correctly${it.aiReply ? ` (your last reply: "${it.aiReply}")` : ''}. Apply it now.`);
  }
  return out.join('\n') + '\n';
}

function xmlText(tag: string, text: string): string {
  // Raw text keeps exact characters. CDATA is used only when the text could
  // close the tag early.
  if (text.includes(`</${tag}`)) {
    return `<${tag}><![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]></${tag}>`;
  }
  return `<${tag}>${text}</${tag}>`;
}

function attr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function chatPreset(m: PromptModel, options: CompileOptions): string {
  const out: string[] = [];
  out.push(`${partLine(m)}I reviewed the document "${m.doc.title}" and left ${plural(m.items.length, 'numbered comment')}. Revise the document as described below.`);
  out.push('');
  out.push('<rules>');
  out.push('- Change only the passages identified in the comments. Keep every other part of the document exactly as it is.');
  out.push('- Each comment quotes the original text it applies to. If a quote appears more than once, use the occurrence between <text_before> and <text_after>.');
  out.push('- Comments of type "exact-replacement" are literal: swap <original_text> for <replacement_text> character for character.');
  out.push("- Other comments need your judgment. Keep the document's language, tone and formatting.");
  out.push('- Comments with intent "question" need an answer only. Do not edit the document for them.');
  out.push('- References such as #3 point to other comments.');
  if (options.chatOutput === 'full') {
    out.push('- Return the complete revised document in a single Markdown code block. After it, list every comment number with "done", "skipped: <reason>" or "answer: <answer>".');
  } else {
    out.push('- For each comment, return only the revised passage, labelled with the comment number. Then list every comment number with "done", "skipped: <reason>" or "answer: <answer>".');
  }
  out.push('</rules>');
  if (m.directives.length) {
    out.push('');
    out.push('<document_wide_instructions>');
    for (const d of m.directives) out.push(xmlText('instruction', d));
    out.push('</document_wide_instructions>');
  }
  if (options.includeDocument) {
    out.push('');
    out.push(`<document title="${attr(m.doc.title)}" lines="${m.doc.lineCount}">`);
    out.push(m.source.includes('</document') ? `<![CDATA[${m.source.split(']]>').join(']]]]><![CDATA[>')}]]>` : m.source);
    out.push('</document>');
  }
  out.push('');
  out.push('<comments>');
  for (const it of m.items) {
    const type = it.isReplace ? 'exact-replacement' : 'instruction';
    out.push(`<comment id="${it.number}" intent="${it.intent}" priority="${it.priority}" type="${type}">`);
    out.push(xmlText('location', it.location));
    out.push(xmlText('original_text', it.isReplace ? it.original : it.originalForDisplay));
    if (it.ambiguous) {
      out.push(xmlText('text_before', it.prefix));
      out.push(xmlText('text_after', it.suffix));
    }
    if (it.isReplace) {
      out.push(xmlText('replacement_text', it.replacement));
      if (it.instruction) out.push(xmlText('note', it.instruction));
    } else {
      out.push(xmlText('instruction', it.instruction));
    }
    if (it.isRetry) out.push(xmlText('second_attempt', `Requested before and not applied correctly${it.aiReply ? ` (last reply: "${it.aiReply}")` : ''}. Apply it now.`));
    out.push('</comment>');
  }
  out.push('</comments>');
  return out.join('\n') + '\n';
}

function structured(m: PromptModel) {
  return {
    schema: 'review-pen/prompt@1',
    ...(m.part && m.part.total > 1 ? { part: { index: m.part.index, total: m.part.total, sections: m.part.sections } } : {}),
    document: { title: m.doc.title, path: m.doc.path, lineCount: m.doc.lineCount, fingerprint: m.doc.fingerprint },
    rules: [
      'Change only the targeted text; leave everything else unchanged.',
      'Locate targets by target.exact; use prefix/suffix when exact is not unique; line numbers are hints.',
      'Items with mode "replace" are literal find-and-replace edits.',
      'Items with intent "question" need an answer, not an edit.',
      'Report each item as done, skipped (with reason) or answered.',
    ],
    directives: m.directives,
    items: m.items.map((it) => ({
      number: it.number,
      intent: it.intent,
      priority: it.priority,
      mode: it.mode,
      location: {
        startLine: it.startLine,
        endLine: it.endLine,
        headingPath: it.headingPath,
        block: it.block,
        blockOrdinal: it.blockOrdinal,
      },
      target: { type: 'TextQuoteSelector', exact: it.original, prefix: it.prefix, suffix: it.suffix },
      occurrences: it.occurrences,
      instruction: it.instruction || null,
      replacement: it.isReplace ? it.replacement : null,
      references: it.references,
      ...(it.isRetry ? { secondAttempt: true, previousReply: it.aiReply || null } : {}),
    })),
  };
}

export const DEFAULT_CUSTOM_TEMPLATE = `Please revise {{doc.path}} ({{doc.lineCount}} lines).
Change only what the items below describe. Keep everything else exactly as it is.
{{#if directives}}
Document-wide instructions:
{{#each directives}}- {{this}}
{{/each}}{{/if}}
{{#each items}}
#{{number}} [{{intentLabel}} / {{priorityLabel}}] {{location}}
{{fence original}}
{{#if isReplace}}Replace with:
{{fence replacement}}
{{else}}Instruction: {{instruction}}
{{/if}}{{/each}}
Reply with "#<n> done" or "#<n> skipped: <reason>" for every item.
`;

function renderModel(m: PromptModel, options: CompileOptions): string {
  switch (options.preset) {
    case 'agent':
      return agentPreset(m);
    case 'chat':
      return chatPreset(m, options);
    case 'json':
      return JSON.stringify(structured(m), null, 2) + '\n';
    case 'yaml':
      return YAML.stringify(structured(m), { lineWidth: 0, minContentWidth: 0, sortMapEntries: false });
    case 'custom':
      return renderTemplate(options.customTemplate ?? DEFAULT_CUSTOM_TEMPLATE, m);
  }
}

/** Split items into parts along top-level section boundaries. */
function chunk(m: PromptModel, options: CompileOptions): ItemView[][] {
  const budget = options.maxTokensPerPart;
  if (!budget || m.items.length === 0) return [m.items];
  const overhead = approxTokens(renderModel({ ...m, items: [] }, options));
  const itemCost = (it: ItemView) => approxTokens(renderModel({ ...m, directives: [], items: [it] }, options)) - approxTokens(renderModel({ ...m, directives: [], items: [] }, options));
  const groups: ItemView[][] = [];
  for (const it of m.items) {
    const g = groups[groups.length - 1];
    if (g && g[0]!.topSection === it.topSection) g.push(it);
    else groups.push([it]);
  }
  const parts: ItemView[][] = [];
  let current: ItemView[] = [];
  let used = overhead;
  const flush = () => {
    if (current.length) parts.push(current);
    current = [];
    used = overhead;
  };
  for (const g of groups) {
    const cost = g.reduce((s, it) => s + itemCost(it), 0);
    if (used + cost <= budget) {
      current.push(...g);
      used += cost;
      continue;
    }
    flush();
    if (overhead + cost <= budget) {
      current.push(...g);
      used += cost;
      continue;
    }
    for (const it of g) {
      const c = itemCost(it);
      if (current.length && used + c > budget) flush();
      current.push(it);
      used += c;
    }
  }
  flush();
  return parts;
}

export function compile(session: Session, options: CompileOptions): CompileResult {
  const model = buildModel(session, options);
  const groups = chunk(model, options);
  const total = groups.length;
  const parts = groups.map((items, i) => {
    const sections = [...new Set(items.map((it) => it.topSection))];
    const m: PromptModel = { ...model, items, part: total > 1 ? { index: i + 1, total, sections } : null };
    const text = renderModel(m, options);
    return { text, itemCount: items.length, sections, approxTokens: approxTokens(text) };
  });
  return { parts, itemCount: model.items.length };
}
