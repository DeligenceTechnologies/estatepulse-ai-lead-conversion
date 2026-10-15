import React, { useEffect } from 'react';
import { PanelClose } from '../leadsources/ManualWebhookPanel';

/**
 * The overlay every Google Sheets dialog uses — the same shell as ConnectModal:
 * Escape and the backdrop close it, and the page behind does not scroll.
 */
export const SheetModal: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, wide, onClose, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} my-8`} onClick={(e) => e.stopPropagation()}>
        <div className="bg-slate-900/95 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              {icon}
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white truncate">{title}</h3>
                {subtitle && <div className="text-xs text-slate-400 mt-0.5">{subtitle}</div>}
              </div>
            </div>
            <PanelClose onClose={onClose} />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

/** The rose block used for failures across the app. Shows the server's own words. */
export const SheetError: React.FC<{ message: string; details?: string[] }> = ({ message, details }) => (
  <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 space-y-1">
    <div>{message}</div>
    {details && details.length > 0 && (
      <ul className="list-disc pl-4 space-y-0.5">
        {details.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
    )}
  </div>
);

/** Error text from anything thrown: the API's message when it has one. */
export const errorText = (e: unknown): string =>
  e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';

/** The API's per-field validation messages, when the error carries them. */
export const errorDetails = (e: unknown): string[] => {
  const details = (e as { details?: { message: string }[] } | null)?.details;
  return Array.isArray(details) ? details.map((d) => d.message) : [];
};

/** "5 min ago" style, for sync times. */
export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}
