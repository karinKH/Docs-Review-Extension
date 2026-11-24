import { LineIndex } from '../text/lines';
import { buildBlocks, buildOutline, parseMarkdown, type BlockInfo, type OutlineEntry } from '../markdown/pipeline';

/** Everything derived from a source text that anchoring needs. Pure and cacheable. */
export interface DocContext {
  source: string;
  lines: LineIndex;
  outline: OutlineEntry[];
  blocks: BlockInfo[];
}

export function createDocContext(source: string, parsed?: { outline: OutlineEntry[]; blocks: BlockInfo[] }): DocContext {
  if (parsed) return { source, lines: new LineIndex(source), outline: parsed.outline, blocks: parsed.blocks };
  const tree = parseMarkdown(source);
  return { source, lines: new LineIndex(source), outline: buildOutline(tree, source), blocks: buildBlocks(tree) };
}
