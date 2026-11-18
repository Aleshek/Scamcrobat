/** The "View" menu of the toolbar: rotating the view, pages side by side, full screen. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Check, ChevronDown, Columns2, Expand, RectangleVertical, RotateCcw, RotateCw } from "lucide-react";
import type { PageMode } from "../engine/types";
import { useT } from "../i18n";

interface Props {
  disabled: boolean;
  rotation: number;
  pageMode: PageMode;
  onRotate(dir: 1 | -1): void;
  onPageMode(mode: PageMode): void;
  onFullscreen(): void;
}

const MENU_WIDTH = 290;

export function ViewMenu(props: Props) {
  const t = useT();
  const v = t.view;
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere and on Esc; arrows move between the items.
  useEffect(() => {
    if (!open) return;
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]") ?? [])];
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.stopPropagation();
        if (e.key === "Escape") e.preventDefault();
        setOpen(null);
        buttonRef.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = (i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const onResize = () => setOpen(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(null);
      return;
    }
    // (fixed position: the toolbar clips what overflows it)
    const r = buttonRef.current!.getBoundingClientRect();
    setOpen({ left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)), top: r.bottom + 4 });
  };

  const choose = (fn: () => void) => () => {
    setOpen(null);
    fn();
  };

  const item = (icon: ReactNode, label: string, shortcut: string | null, onClick: () => void, checked?: boolean) => (
    <button
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="menu-item"
      onClick={choose(onClick)}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {checked !== undefined && <span className="menu-check">{checked && <Check size={15} />}</span>}
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );

  const rotated = props.rotation !== 0;
  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        className={open || rotated || props.pageMode !== "single" ? "tb-btn toggled" : "tb-btn"}
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={!!open}
        title={rotated ? `${v.menuTitle}\n${v.rotated(props.rotation)}` : v.menuTitle}
        onClick={toggle}
      >
        <BookOpen size={18} />
        <span className="tb-text l2">{v.menu}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="menu" role="menu" ref={menuRef} style={{ left: open.left, top: open.top, width: MENU_WIDTH }}>
          {item(<RotateCw size={16} />, v.rotateRight, "Ctrl+Shift++", () => props.onRotate(1))}
          {item(<RotateCcw size={16} />, v.rotateLeft, "Ctrl+Shift+−", () => props.onRotate(-1))}
          <div className="menu-sep" role="separator" />
          {item(<RectangleVertical size={16} />, v.single, null, () => props.onPageMode("single"), props.pageMode === "single")}
          {item(<Columns2 size={16} />, v.two, null, () => props.onPageMode("two"), props.pageMode === "two")}
          {item(<BookOpen size={16} />, v.cover, null, () => props.onPageMode("cover"), props.pageMode === "cover")}
          <div className="menu-sep" role="separator" />
          {item(<Expand size={16} />, v.fullscreen, "Ctrl+L", props.onFullscreen)}
        </div>
      )}
    </div>
  );
}
