import { cn } from '@qos/ui';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/**
 * Small component kit. Colours come only from the design tokens; spacing uses logical
 * properties (start/end), so every component works in RTL (doc 20 §8).
 */
type Tone = 'primary' | 'secondary' | 'danger' | 'ghost';
const TONE: Record<Tone, string> = {
  primary: 'bg-accent text-accent-contrast border-transparent hover:opacity-90',
  secondary: 'bg-surface text-fg border-line hover:bg-raised',
  danger: 'bg-surface text-danger border-danger hover:bg-raised',
  ghost: 'bg-transparent text-accent border-transparent hover:underline',
};

export function Button({
  tone = 'secondary',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  group = false,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  /** For a group of controls (each with its own label): a div instead of a wrapping label. */
  group?: boolean;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={cn('flex flex-col gap-1 text-sm', className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </Tag>
  );
}

const control = 'rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-fg';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cn(control, className)} {...p} />
);
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cn(control, className)} {...p} />
);
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cn(control, className)} {...p} />
);

export function Card({
  title,
  actions,
  children,
  className,
  testId,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface', className)} data-testid={testId}>
      {title || actions ? (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">{title}</h2>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="page-title">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const BADGE = {
  neutral: 'border-line text-muted',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
  accent: 'border-accent text-accent',
} as const;
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', BADGE[tone])}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-8 text-center" data-testid="empty-state">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-2 text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Notice({
  tone = 'neutral',
  children,
  testId,
}: {
  tone?: 'neutral' | 'danger' | 'success' | 'warning';
  children: ReactNode;
  testId?: string;
}) {
  const cls = {
    neutral: 'border-line',
    danger: 'border-danger text-danger',
    success: 'border-success text-success',
    warning: 'border-warning text-warning',
  }[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-md border px-3 py-2 text-sm', cls)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function Table({
  head,
  children,
  testId,
}: {
  head: ReactNode[];
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="text-muted">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 text-start font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cn('border-t border-line px-3 py-2 align-top', className)}>{children}</td>
);

/** A value that is code-like (ids, keys, URLs): always left-to-right, even in RTL pages. */
export const Ltr = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="font-mono text-xs">
    {children}
  </bdi>
);
