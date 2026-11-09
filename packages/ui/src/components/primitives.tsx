import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react';

/** Server-safe primitives (no hooks). Interactive pieces live in client.tsx. */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  block?: boolean;
  busy?: boolean;
}

export function Button({ variant = 'secondary', icon, block, busy, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('r-button', `r-button--${variant}`, block && 'r-button--block', !children && 'r-button--icon', className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <LoaderCircle className="r-spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
}

/** Styles an anchor like a button. Pass `href`; wrap with next/link in the app when needed. */
export function linkButtonClass(variant: ButtonVariant = 'secondary', extra?: string): string {
  return cx('r-button', `r-button--${variant}`, extra);
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({ tone = 'neutral', icon, children, title }: { tone?: Tone | 'sim' | 'sample'; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className={cx('r-badge', `r-badge--${tone}`)} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** Marks anything produced by the provider simulator. Always visible, never only colour. */
export function SimulatedBadge({ label = 'Simulated' }: { label?: string }) {
  return (
    <span className="r-badge r-badge--sim" title="Produced by Relay’s deterministic provider simulator — not a live platform">
      {label}
    </span>
  );
}

export function SampleBadge() {
  return (
    <span className="r-badge r-badge--sample" title="Sample content seeded for the demo">
      Sample
    </span>
  );
}

const BANNER_ICONS: Record<Tone, ReactNode> = {
  info: <Info aria-hidden />,
  success: <CircleCheck aria-hidden />,
  warning: <TriangleAlert aria-hidden />,
  danger: <CircleAlert aria-hidden />,
  neutral: <Info aria-hidden />,
};

export function Banner({ tone = 'info', title, children, live }: { tone?: Tone; title?: ReactNode; children?: ReactNode; live?: boolean }) {
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={cx('r-banner', `r-banner--${tone}`)} role={role}>
      {BANNER_ICONS[tone]}
      <div className="r-banner__body">
        {title ? <strong>{title}</strong> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

export function Card({ children, flat, className, as: As = 'section', ...rest }: { children: ReactNode; flat?: boolean; className?: string; as?: 'section' | 'div' | 'article' | 'li'; 'aria-labelledby'?: string }) {
  return (
    <As className={cx('r-card', flat && 'r-card--flat', className)} {...rest}>
      {children}
    </As>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="r-empty">
      {icon}
      <h2 className="r-strong" style={{ fontSize: 'var(--text-md)' }}>
        {title}
      </h2>
      {children ? <div className="r-small" style={{ maxWidth: 480 }}>{children}</div> : null}
      {action}
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="r-field">
      <label className="r-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="r-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="r-error-text" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** aria-describedby value for an input inside <Field>. */
export function describedBy(id: string, options: { hint?: unknown; error?: unknown }): string | undefined {
  const ids = [options.hint ? `${id}-hint` : null, options.error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(' ') : undefined;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="r-row-tight r-muted r-small">
      <LoaderCircle className="r-spinner" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="r-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped}>
      <div className="r-progress__bar" style={{ transform: `scaleX(${clamped / 100})` }} />
    </div>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="r-visually-hidden">{children}</span>;
}

export function Skeleton({ width = '100%', height = 16 }: { width?: number | string; height?: number }) {
  return <div className="r-skeleton" style={{ width, height }} aria-hidden />;
}

export function RTile({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#C4C5C3" />
      <path d="M11 24V8h6.5a4.5 4.5 0 0 1 0 9H11m5.5 0L22 24" fill="none" stroke="#141414" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Stand-in wordmark (tile + name); replace with the kit's custom wordmark. */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="r-row-tight" style={{ gap: 10 }}>
      <RTile size={size} />
      <span style={{ fontWeight: 600, fontSize: size * 0.68, letterSpacing: '-0.01em' }}>Relay</span>
    </span>
  );
}
