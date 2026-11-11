import type { TFunction } from 'i18next';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { ApiRequestError } from './api';

/** Translate an API error by its code, falling back to a generic message. */
export function errorText(error: unknown, t: TFunction): string {
  const code = error instanceof ApiRequestError ? error.code : 'unknown';
  return t(`admin.errors.${code}`, { defaultValue: t('admin.errors.unknown') });
}

export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiRequestError ? (error.fields ?? {}) : {};
}

export function Field({
  label,
  error,
  ...input
}: { label: string; error?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const errorId = error && input.id ? `${input.id}-error` : undefined;
  return (
    <div>
      <label htmlFor={input.id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className="mt-1 block min-h-11 w-full rounded-md border border-slate-400 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
      />
      {error && (
        <p id={errorId} className="mt-1 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: { variant?: 'primary' | 'secondary' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const look =
    variant === 'primary'
      ? 'border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900'
      : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100';
  return (
    <button
      type="button"
      {...props}
      className={`min-h-11 rounded-md border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:opacity-60 ${look} ${className}`}
    />
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
    >
      {children}
    </p>
  );
}

export function Select({
  label,
  error,
  children,
  ...select
}: {
  label: string;
  error?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div>
      <label htmlFor={select.id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        {...select}
        aria-invalid={error ? true : undefined}
        className="mt-1 block min-h-11 w-full rounded-md border border-slate-400 bg-white px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
      >
        {children}
      </select>
      {error && <p className="mt-1 text-sm text-red-800">{error}</p>}
    </div>
  );
}

export function Textarea({
  label,
  ...area
}: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div>
      <label htmlFor={area.id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        {...area}
        rows={area.rows ?? 2}
        className="mt-1 block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
      />
    </div>
  );
}

/** Scrolls sideways on a narrow screen instead of squashing the columns. */
export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="mt-3 w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-start">
            {headers.map((header) => (
              <th key={header} scope="col" className="px-3 py-2 text-start font-medium">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = title.replace(/\W+/g, '-').toLowerCase();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm text-slate-700">{children}</p>;
}
