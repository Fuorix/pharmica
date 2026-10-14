import { ReactNode, useEffect } from "react";

/** A modal panel. Esc closes it; keys typed inside it do not reach the billing shortcuts. */
export function Dialog({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onClose]);

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={wide ? "dialog wide" : "dialog"} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="ghost" onClick={onClose}>Esc</button></header>
      <div className="dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </section>
  </div>;
}
