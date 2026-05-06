// Typeahead state hook. Buffers printable characters pressed within
// `timeoutMs` of each other; the buffer is consumed by the file-tree
// container to drive a `prefixMatch` predicate. The timeout window
// mirrors the WAI-ARIA tree spec recommendation. Normalization is
// case-insensitive with no special section-symbol handling — see the
// "typeahead normalization" TODO for the post-launch revisit.
//
// The buffer is held in a ref so `appendChar` can return the post-
// append buffer synchronously to the caller — typeahead jumps focus on
// the same event tick rather than waiting for a re-render.

import { useCallback, useEffect, useRef } from "react";

export interface UseTypeaheadResult {
  /** Append a single character; returns the buffer the caller should match against. */
  appendChar: (char: string) => string;
  /** Clear the buffer immediately (e.g. on Escape, blur, or focus change). */
  reset: () => void;
}

export function useTypeahead(timeoutMs = 500): UseTypeaheadResult {
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    bufferRef.current = "";
  }, []);

  const appendChar = useCallback(
    (char: string) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const next = bufferRef.current + char.toLowerCase();
      bufferRef.current = next;
      timerRef.current = setTimeout(() => {
        bufferRef.current = "";
        timerRef.current = null;
      }, timeoutMs);
      return next;
    },
    [timeoutMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { appendChar, reset };
}
