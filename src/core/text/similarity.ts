// Text similarity for re-anchoring. Sørensen–Dice coefficient over character
// bigrams of normalised text: 1 = same text, 0 = nothing in common.
// Deterministic and independent of language or script (works for Hebrew).

function normalise(s: string): string {
  return s.toLowerCase().replace(/[*_`#>~\-[\]()|]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  for (const [g, n] of bx) overlap += Math.min(n, by.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}
