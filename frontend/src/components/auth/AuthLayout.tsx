import React from 'react';
import { Zap } from 'lucide-react';

/** Shared chrome for the two auth pages. */
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

export const Field: React.FC<{
  label: string;
  name: string;
  type?: string;
  value: string;
  autoComplete?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}> = ({ label, name, type = 'text', value, autoComplete, onChange, disabled, hint }) => (
  <label className="block">
    <span className="block text-xs font-medium text-slate-300 mb-1.5">{label}</span>
    <input
      name={name}
      type={type}
      value={value}
      autoComplete={autoComplete}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2.5 rounded-lg bg-slate-950 border border-slate-800 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40 disabled:opacity-50 transition-colors"
    />
    {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
  </label>
);

export const SubmitButton: React.FC<{ busy: boolean; children: React.ReactNode }> = ({ busy, children }) => (
  <button
    type="submit"
    disabled={busy}
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
