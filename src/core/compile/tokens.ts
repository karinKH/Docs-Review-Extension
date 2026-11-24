// Token counting.
// - approxTokens: fast, deterministic heuristic used for splitting long prompts.
// - countOpenAITokens: exact count with OpenAI's published o200k tokenizer,
//   loaded lazily (about 2 MB). Claude and Gemini tokenizers are not public,
//   so for those models the UI shows an estimate.

export function approxTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  // ~4 ASCII characters per token; non-Latin scripts (e.g. Hebrew) tokenise denser.
  return Math.ceil(ascii / 4 + other / 1.6);
}

type Encoder = { encode(text: string): number[] };
let encoderPromise: Promise<Encoder> | null = null;

async function loadEncoder(): Promise<Encoder> {
  const [{ Tiktoken }, ranks] = await Promise.all([import('js-tiktoken/lite'), import('js-tiktoken/ranks/o200k_base')]);
  return new Tiktoken(ranks.default);
}

export async function countOpenAITokens(text: string): Promise<number> {
  encoderPromise ??= loadEncoder();
  const enc = await encoderPromise;
  return enc.encode(text).length;
}
