import { ComponentProps, createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface Toast { id: number; text: string; kind: 'ok' | 'error' }
const ToastContext = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} data-testid={`toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** A button that shows a pending state and cannot be double-clicked while its action runs. */
export function Button({ onAct, busyLabel, children, disabled, ...rest }: ComponentProps<'button'> & { onAct?: () => Promise<unknown> | unknown; busyLabel?: string }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      onClick={async () => {
        if (!onAct) return;
        setBusy(true);
        try {
          await onAct();
        } finally {
          if (alive.current) setBusy(false);
        }
      }}
    >
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, testid }: { checked: boolean; onChange: (next: boolean) => void; label: string; description?: ReactNode; disabled?: boolean; testid?: string }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-text">
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function Confirm({ title, body, confirmLabel, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; onConfirm: () => Promise<unknown> | unknown; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2>{title}</h2>
        <div className="muted">{body}</div>
        <div className="row end">
          <button type="button" ref={cancel} className="btn" onClick={onCancel} data-testid="confirm-cancel">Cancel</button>
          <Button className="btn danger" onAct={onConfirm} busyLabel="Working…" data-testid="confirm-ok">{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty" role="status">{label}</div>;
}
