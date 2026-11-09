'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './primitives';

/**
 * Modal dialog on the native <dialog> element: the browser makes the page inert, traps
 * focus and handles Escape. We additionally move focus to the first field (or the dialog),
 * label it by its title, and restore focus to the opener when it closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      const first = dialog.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea, button:not([data-dialog-close])');
      (first ?? dialog).focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      onClose();
      const target = opener.current as HTMLElement | null;
      if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className={cx('r-dialog', wide && 'r-dialog--wide')} aria-labelledby={titleId} aria-describedby={description ? descId : undefined} tabIndex={-1}>
      {open ? (
        <div className="r-dialog__inner">
          <div className="r-dialog__header">
            <div className="r-stack-sm">
              <h2 id={titleId}>{title}</h2>
              {description ? (
                <p id={descId} className="r-small r-muted">
                  {description}
                </p>
              ) : null}
            </div>
            <button type="button" className="r-button r-button--ghost r-button--icon" data-dialog-close aria-label="Close dialog" onClick={() => ref.current?.close()}>
              <X aria-hidden />
            </button>
          </div>
          <div className="r-dialog__body">{children}</div>
          {footer ? <div className="r-dialog__footer">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  message: string;
}

const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => {});

/** Polite live region for transient confirmations; errors stay inline next to their cause. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        role="status"
        style={{ position: 'fixed', bottom: 16, right: 16, left: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'none', zIndex: 50 }}
      >
        {toasts.map((t) => (
          <div key={t.id} className={cx('r-banner', `r-banner--${t.tone}`)} style={{ pointerEvents: 'auto', maxWidth: 420, boxShadow: 'var(--shadow-raised)' }}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
