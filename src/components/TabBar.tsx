import { useEffect, useRef } from "react";
import { FileText, House, Plus, X } from "lucide-react";
import { useT } from "../i18n";
import type { Tab } from "../tabs";

interface Props {
  tabs: Tab[];
  activeId: number;
  /** While organizing pages the tabs cannot be switched */
  disabled: boolean;
  onActivate(id: number): void;
  onClose(id: number): void;
  onNew(): void;
}

export function TabBar({ tabs, activeId, disabled, onActivate, onClose, onNew }: Props) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when there are many tabs.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div className={disabled ? "tabbar disabled" : "tabbar"} inert={disabled}>
      <div className="tabbar-list" role="tablist" ref={listRef}>
        {tabs.map((tab) => {
          const title = tab.doc?.name ?? t.tabs.start;
          const dirty = !!tab.doc?.dirty;
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              data-tab={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={["tab", active && "active", dirty && "dirty"].filter(Boolean).join(" ")}
              title={tab.doc?.path ?? title}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onActivate(tab.id);
              }}
            >
              {tab.doc ? <FileText size={14} className="tab-icon" /> : <House size={14} className="tab-icon" />}
              <span className="tab-title">{title}</span>
              <button
                className="tab-close"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title={dirty ? `${t.tabs.unsaved} · ${t.tabs.close}` : t.tabs.close}
                aria-label={t.tabs.close}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="tab-new" onClick={onNew} title={t.tabs.newTab} aria-label={t.tabs.newTab}>
        <Plus size={16} />
      </button>
    </div>
  );
}
