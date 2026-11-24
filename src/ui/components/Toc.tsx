import { memo } from 'react';
import { directionOf, type OutlineEntry } from '../../core/markdown/pipeline';
import type { Annotation } from '../../core/types';
import { IconCheck, IconComment } from './Icons';

interface Props {
  outline: OutlineEntry[];
  annotations: Annotation[];
  reviewed: string[];
  activeSlug: string | null;
  onJump: (entry: OutlineEntry) => void;
  onCommentSection: (entry: OutlineEntry, rect: { top: number; bottom: number; left: number; right: number }) => void;
  onToggleReviewed: (slug: string) => void;
}

function TocImpl({ outline, annotations, reviewed, activeSlug, onJump, onCommentSection, onToggleReviewed }: Props) {
  const minDepth = outline.reduce((m, e) => Math.min(m, e.depth), 6);
  const done = outline.filter((e) => reviewed.includes(e.slug)).length;
  const pct = outline.length ? Math.round((done / outline.length) * 100) : 0;
  // Mirror the whole column only when most headings are right-to-left. Otherwise
  // each Hebrew/Arabic heading keeps its own reading order but lines up with the rest.
  const rtlCount = outline.filter((e) => directionOf(e.text) === 'rtl').length;
  const dir = outline.length && rtlCount > outline.length / 2 ? 'rtl' : 'ltr';
  return (
    <nav className="toc-inner" aria-label="Table of contents" dir={dir}>
      <div className="toc-head">
        <span className="eyebrow">Contents</span>
        {outline.length ? (
          <span className="toc-progress" title="Sections you marked as reviewed">
            {done}/{outline.length} reviewed
          </span>
        ) : null}
      </div>
      {outline.length ? (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Review progress">
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {outline.length === 0 ? <p className="muted small">This document has no headings.</p> : null}
      <ul className="toc-list">
        {outline.map((e) => {
          const count = annotations.filter((a) => a.anchor.start >= e.start && a.anchor.start < e.sectionEnd && a.status !== 'resolved').length;
          const isReviewed = reviewed.includes(e.slug);
          return (
            <li key={`${e.slug}-${e.start}`} className={`toc-item${activeSlug === e.slug ? ' active' : ''}${isReviewed ? ' reviewed' : ''}`} style={{ paddingInlineStart: `${(e.depth - minDepth) * 12 + 4}px` }}>
              <button type="button" className="toc-check" aria-pressed={isReviewed} title={isReviewed ? 'Mark as not reviewed' : 'Mark as reviewed'} onClick={() => onToggleReviewed(e.slug)}>
                {isReviewed ? <IconCheck size={11} /> : null}
              </button>
              <button type="button" className="toc-link" onClick={() => onJump(e)} title={e.text}>
                <bdi dir={directionOf(e.text) === 'rtl' ? 'rtl' : 'ltr'}>{e.text || 'Untitled'}</bdi>
              </button>
              <button
                type="button"
                className="toc-comment"
                title="Comment on this whole section"
                aria-label={`Comment on the section ${e.text}`}
                onClick={(ev) => {
                  const r = ev.currentTarget.getBoundingClientRect();
                  onJump(e);
                  onCommentSection(e, { top: r.top, bottom: r.bottom, left: r.right + 8, right: r.right + 8 });
                }}
              >
                <IconComment size={13} />
              </button>
              {count ? <span className="toc-count" title={`${count} open comment${count === 1 ? '' : 's'}`}>{count}</span> : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export const Toc = memo(TocImpl);
