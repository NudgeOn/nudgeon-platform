import { useEffect, useState } from "react";

/** 값 변경을 debounce (세그먼트 미리보기 500ms — PRD-05 3.3) */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
