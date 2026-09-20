'use client';

/**
 * NURAE — visibility-aware polling.
 *
 * A tiny replacement for bare `setInterval(refresh, ms)` loops: identical
 * cadence, but the tick is skipped while the document is hidden so a
 * background tab stops hammering the API. The callback is kept in a ref so
 * the interval is not torn down when callers pass an unstable function.
 */

import { useEffect, useRef } from 'react';

export function usePoll(fn: () => void | Promise<void>, ms: number) {
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      void fnRef.current();
    };
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
}
