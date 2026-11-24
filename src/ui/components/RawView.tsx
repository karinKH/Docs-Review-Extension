import { memo, useMemo } from 'react';
import { LineIndex } from '../../core/text/lines';
import { directionOf } from '../../core/markdown/pipeline';

/** Raw Markdown with line numbers. Every line maps 1:1 to the source. */
function RawViewImpl({ source }: { source: string }) {
  const rows = useMemo(() => {
    const idx = new LineIndex(source);
    const out: { n: number; s: number; e: number; text: string }[] = [];
    for (let n = 1; n <= Math.max(1, idx.lineCount); n++) {
      const s = idx.startOf(n);
      const e = idx.endOf(n);
      out.push({ n, s, e, text: source.slice(s, e) });
    }
    return out;
  }, [source]);
  const width = String(rows.length).length;
  return (
    <div className="raw" style={{ ['--ln-w' as string]: `${width + 1}ch` }}>
      {rows.map((r) => (
        <div key={r.n} className="raw-line" data-sp={`${r.s}:${r.e}`} data-line={r.n}>
          <span className="ln" aria-hidden="true">{r.n}</span>
          <span className="lt" data-sp={`${r.s}:${r.e}`} dir={directionOf(r.text)}>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

export const RawView = memo(RawViewImpl);
