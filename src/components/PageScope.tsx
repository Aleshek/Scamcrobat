import { useMemo, useState } from "react";
import { parsePageRange } from "../export/pageRange";
import { useT } from "../i18n";

export type Scope = "all" | "current" | "range";

export interface PageScopeState {
  scope: Scope;
  setScope(scope: Scope): void;
  rangeText: string;
  setRangeText(text: string): void;
  /** Chosen 0-based page indices; null when the range is invalid */
  pages: number[] | null;
}

/** Which pages to export / print / change: all, the current one, or a range like "1-3, 5". */
export function usePageScope(pageCount: number, currentPage: number, initial: Scope = "all"): PageScopeState {
  const [scope, setScope] = useState<Scope>(initial);
  const [rangeText, setRangeText] = useState(`1-${pageCount}`);
  const pages = useMemo(() => {
    if (scope === "all") return Array.from({ length: pageCount }, (_, i) => i);
    if (scope === "current") return [currentPage];
    return parsePageRange(rangeText, pageCount);
  }, [scope, rangeText, pageCount, currentPage]);
  return { scope, setScope, rangeText, setRangeText, pages };
}

export function PageScopeField(props: {
  state: PageScopeState;
  pageCount: number;
  currentPage: number;
  /** Label of the "current page" choice (e.g. "This page (3)") */
  currentLabel?: (n: number) => string;
}) {
  const t = useT();
  const { scope, setScope, rangeText, setRangeText, pages } = props.state;
  return (
    <fieldset className="field">
      <legend>{t.pageScope.title}</legend>
      <label className="radio">
        <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
        {t.pageScope.all(props.pageCount)}
      </label>
      <label className="radio">
        <input type="radio" checked={scope === "current"} onChange={() => setScope("current")} />
        {(props.currentLabel ?? t.pageScope.current)(props.currentPage + 1)}
      </label>
      <label className="radio">
        <input type="radio" checked={scope === "range"} onChange={() => setScope("range")} />
        {t.pageScope.range}
        <input
          className={scope === "range" && !pages ? "input invalid" : "input"}
          value={rangeText}
          onFocus={() => setScope("range")}
          onChange={(e) => setRangeText(e.target.value)}
          placeholder={t.pageScope.rangePlaceholder}
        />
      </label>
    </fieldset>
  );
}
