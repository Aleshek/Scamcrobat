/**
 * Hides toolbar button labels step by step when the toolbar does not fit the window:
 * first the labels marked `l1`, then `l2`, then `l3`, finally all of them (CSS
 * `.toolbar[data-compact]`). It measures the real content, so it works for every
 * language and set of buttons.
 */
import { useLayoutEffect, type DependencyList, type RefObject } from "react";

const LEVELS = 4;

function fit(el: HTMLElement) {
  for (let level = 0; level <= LEVELS; level++) {
    el.dataset.compact = String(level);
    if (el.scrollWidth <= el.clientWidth) return;
  }
}

/** `deps`: whatever changes which buttons the toolbar shows. */
export function useFitLabels(ref: RefObject<HTMLElement | null>, deps: DependencyList) {
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, deps);

  // Window resizes and buttons changing width (another language, a search result count).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => fit(el));
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [ref]);
}
