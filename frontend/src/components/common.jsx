import { useId } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";

export function Card({ className = "", children, ...p }) {
  return (
    <div className={`luxury-card bg-card rounded-lg border border-border shadow-sm ${className}`} {...p}>
      {children}
    </div>
  );
}

export function Btn({ variant = "primary", className = "", children, ...p }) {
  const reduceMotion = useReducedMotion();
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold transition-all duration-200 px-4 py-2.5 disabled:opacity-50 disabled:pointer-events-none";
  const v = {
    primary: "bg-primary text-primary-foreground shadow-sm hover:brightness-110 hover:shadow-md",
    ghost: "bg-transparent text-slate-600 hover:bg-secondary",
    outline: "border border-border bg-white text-slate-700 hover:border-primary/30 hover:bg-secondary/70",
    danger: "bg-red-700 text-white hover:bg-red-800",
    success: "bg-primary text-primary-foreground hover:brightness-110",
    subtle: "bg-accent text-accent-foreground hover:brightness-95",
  }[variant];
  return (
    <motion.button
      whileHover={reduceMotion ? undefined : { y: -1, scale: 1.015 }}
      whileTap={reduceMotion ? undefined : { y: 0, scale: 0.975 }}
      transition={{ type: "spring", stiffness: 520, damping: 32, mass: 0.4 }}
      className={`${base} ${v} ${className}`}
      {...p}
    >
      {children}
    </motion.button>
  );
}

export function Input({ label, className = "", ...p }) {
  return (
    <label className="block">
      {label && <span className="block text-xs font-semibold text-slate-500 mb-1.5">{label}</span>}
      <input
        className={`w-full rounded-md border border-input bg-white/90 px-3 py-2.5 text-sm text-slate-800 outline-none transition-shadow focus:ring-2 focus:ring-primary/20 focus:border-primary ${className}`}
        {...p}
      />
    </label>
  );
}

export function Select({ label, children, className = "", ...p }) {
  return (
    <label className="block">
      {label && <span className="block text-xs font-semibold text-slate-500 mb-1.5">{label}</span>}
      <select
        className={`w-full rounded-md border border-input bg-white/90 px-3 py-2.5 text-sm text-slate-800 outline-none transition-shadow focus:ring-2 focus:ring-primary/20 focus:border-primary ${className}`}
        {...p}
      >
        {children}
      </select>
    </label>
  );
}

export function Textarea({ label, className = "", ...p }) {
  return (
    <label className="block">
      {label && <span className="block text-xs font-semibold text-slate-500 mb-1.5">{label}</span>}
      <textarea
        className={`w-full rounded-md border border-input bg-white/90 px-3 py-2.5 text-sm text-slate-800 outline-none transition-shadow focus:ring-2 focus:ring-primary/20 focus:border-primary ${className}`}
        {...p}
      />
    </label>
  );
}

export function Badge({ children, cls = "bg-slate-100 text-slate-600 border-slate-200", ...p }) {
  return (
    <span {...p} className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {children}
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide = false }) {
  const titleId = useId();
  const reduceMotion = useReducedMotion();
  const spring = { type: "spring", stiffness: 380, damping: 32, mass: 0.65 };
  return createPortal(
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key={titleId}
          className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-3 sm:p-8"
          style={{
            paddingTop: "max(0.75rem, env(safe-area-inset-top))",
            paddingRight: "max(0.75rem, env(safe-area-inset-right))",
            paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
            paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
          }}
          onClick={onClose}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={`liquid-glass-surface my-0 flex w-full flex-col overflow-hidden rounded-2xl border border-white/70 shadow-2xl sm:my-4 ${wide ? "max-w-3xl" : "max-w-lg"}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: "calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))" }}
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.975 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={reduceMotion ? { duration: 0 } : spring}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3 sm:px-6 sm:py-4">
              <h3 id={titleId} className="text-lg font-bold text-slate-900 font-display">{title}</h3>
              <button onClick={onClose} aria-label="Close dialog" data-testid="modal-close" className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-black/5 hover:text-slate-700">
                <X size={20} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 font-display">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function Empty({ icon: Icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && <Icon className="text-slate-300 mb-3" size={40} />}
      <p className="text-slate-600 font-semibold">{title}</p>
      {hint && <p className="text-sm text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}
