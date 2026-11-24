/** Fast offset <-> line conversion for a source string. Lines are 1-based. */
export class LineIndex {
  readonly starts: number[];
  constructor(readonly text: string) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }

  get lineCount(): number {
    // A trailing newline does not start a new visible line.
    const n = this.starts.length;
    return this.text.endsWith('\n') ? n - 1 : n;
  }

  /** 1-based line containing offset. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** Offset of the first character of a 1-based line. */
  startOf(line: number): number {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))]!;
  }

  /** Offset just past the last character of a 1-based line (excluding the newline). */
  endOf(line: number): number {
    const next = this.starts[line];
    return next === undefined ? this.text.length : next - 1;
  }

  /** Inclusive line range covering [start, end). */
  range(start: number, end: number): { startLine: number; endLine: number } {
    const startLine = this.lineOf(start);
    const endLine = this.lineOf(Math.max(start, end - 1));
    return { startLine, endLine };
  }
}
