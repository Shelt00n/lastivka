import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** full = full-height modal (new chat); default = bottom action sheet */
  variant?: "action" | "full";
  label: string;
}

export function Sheet({ open, onClose, children, variant = "action", label }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const root = document.getElementById("app-frame") ?? document.body;
  return createPortal(
    <div className={`sheet sheet--${variant}`} role="dialog" aria-modal="true" aria-label={label}>
      <div className="sheet__backdrop" onClick={onClose} />
      <div className="sheet__panel">{children}</div>
    </div>,
    root,
  );
}

interface ActionProps {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

export function SheetAction({ icon, children, onClick, danger }: ActionProps) {
  return (
    <button type="button" className={`sheet-action${danger ? " sheet-action--danger" : ""}`} onClick={onClick}>
      <span className="sheet-action__label">{children}</span>
      {icon && <span className="sheet-action__icon">{icon}</span>}
    </button>
  );
}
