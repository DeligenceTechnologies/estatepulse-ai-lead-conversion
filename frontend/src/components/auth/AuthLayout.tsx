import React, { useState } from 'react';
import { Eye, EyeOff, Info, Zap } from 'lucide-react';

/** Shared chrome for the auth pages. */
export const AuthLayout: React.FC<{
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}> = ({ title, subtitle, children, footer }) => (
  <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-12 font-sans">
    <div className="w-full max-w-md">
      <div className="flex items-center gap-2.5 mb-8 justify-center">
        <div className="w-9 h-9 rounded-xl bg-emerald-600 flex items-center justify-center">
          <Zap className="w-5 h-5 text-white" />
        </div>
        <span className="text-lg font-bold tracking-tight">EstatePulse AI</span>
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-7">
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-slate-400 mt-1 mb-6">{subtitle}</p>
        {children}
      </div>

      <div className="text-center text-sm text-slate-400 mt-6">{footer}</div>
    </div>
  </div>
);

const inputClass =
  'w-full px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40 disabled:opacity-50 transition-colors';

interface FieldProps {
  label: string;
  name: string;
  type?: string;
  value: string;
  autoComplete?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  /** Shown under the input in place of the hint. */
  error?: string | null;
}

export const Field: React.FC<FieldProps> = ({
  label,
  name,
  type = 'text',
  value,
  autoComplete,
  onChange,
  disabled,
  hint,
  required,
  minLength,
  maxLength,
  placeholder,
  error,
}) => (
  <label className="block">
    <span className="block text-xs font-medium text-slate-300 mb-1.5">{label}</span>
    <input
      name={name}
      type={type}
      value={value}
      autoComplete={autoComplete}
      disabled={disabled}
      required={required}
      minLength={minLength}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-invalid={error ? true : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} ${error ? 'border-red-800' : ''}`}
    />
    <FieldNote hint={hint} error={error} />
  </label>
);

/** A password input with a show/hide toggle. */
export const PasswordField: React.FC<Omit<FieldProps, 'type'>> = ({
  label,
  name,
  value,
  autoComplete,
  onChange,
  disabled,
  hint,
  required,
  minLength,
  maxLength,
  error,
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <label className="block">
      <span className="block text-xs font-medium text-slate-300 mb-1.5">{label}</span>
      <div className="relative">
        <input
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          disabled={disabled}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} pr-10 ${error ? 'border-red-800' : ''}`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-500 hover:text-slate-300 cursor-pointer disabled:cursor-not-allowed"
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <FieldNote hint={hint} error={error} />
    </label>
  );
};

const FieldNote: React.FC<{ hint?: string; error?: string | null }> = ({ hint, error }) =>
  error ? (
    <span className="block text-xs text-red-400 mt-1">{error}</span>
  ) : hint ? (
    <span className="block text-xs text-slate-500 mt-1">{hint}</span>
  ) : null;

export const Checkbox: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ label, hint, checked, onChange, disabled }) => (
  <label className="flex items-start gap-2.5 cursor-pointer select-none">
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 w-4 h-4 rounded border-slate-700 bg-slate-950 accent-emerald-600 cursor-pointer"
    />
    <span>
      <span className="block text-sm text-slate-200">{label}</span>
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </span>
  </label>
);

export const SubmitButton: React.FC<{ busy: boolean; children: React.ReactNode; disabled?: boolean }> = ({
  busy,
  children,
  disabled,
}) => (
  <button
    type="submit"
    disabled={busy || disabled}
    className="w-full px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:hover:bg-emerald-600 text-on-accent text-sm font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed"
  >
    {busy ? 'Please wait…' : children}
  </button>
);

export const FormError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div role="alert" className="mb-4 px-3 py-2.5 rounded-lg bg-red-950/50 border border-red-900/70 text-sm text-red-300">
      {message}
    </div>
  ) : null;

/** A neutral message, e.g. why the user was signed out. */
export const FormNotice: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div
      role="status"
      className="mb-4 px-3 py-2.5 rounded-lg bg-emerald-950/40 border border-emerald-900/60 text-sm text-emerald-200 flex items-start gap-2"
    >
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  ) : null;

/** Matches the backend's rule for new passwords. */
export const MIN_PASSWORD_LENGTH = 8;
