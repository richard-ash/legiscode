// Shared text normalizer for the bill-diff pipeline. PDF-extracted prose
// and corpus baseline text live in different normalization domains —
// PDF runs come through `runsToText` (`\n` between runs that pdfjs flags
// EOL, spaces otherwise), corpus baselines come through `bodyToText`
// (paragraph joiners and section headers reflowed). The aligner in
// emit-diff.ts cannot match across these domains until both sides are
// reduced to the same canonical token stream.
//
// Two-step normalization:
//   1. Unicode NFC. Combining characters and pre-composed variants
//      shouldn't classify as different tokens.
//   2. Whitespace collapse. Any run of Unicode whitespace becomes one
//      ASCII space; leading/trailing whitespace is dropped.
//
// Round-trip stability is the load-bearing invariant: feeding the
// output back into normalize() must be a no-op, so emit-diff's
// equivalence check is symmetric.

const WHITESPACE_RUN = /\s+/gu;

export function normalize(text: string): string {
  const nfc = text.normalize("NFC");
  return nfc.replace(WHITESPACE_RUN, " ").trim();
}

// Tokenisation for the paragraph-anchored token scan: split the
// normalized text on the single ASCII space normalize() produces. Empty
// strings come through only for the empty input, which yields [].
export function tokenize(text: string): string[] {
  const n = normalize(text);
  if (n.length === 0) return [];
  return n.split(" ");
}
