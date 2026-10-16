import React, { useEffect } from 'react';
import { ConnectFormPanel } from './ConnectFormPanel';

/**
 * Connect a form through its provider's API (Tally, Typeform): we hold the
 * key, install the webhook and can repair it later. Same panel, different
 * provider code — the card that was clicked decides which.
 *
 * It lives on Lead Integrations, not on Lead Sources: connecting is a
 * setup act you do once, while Lead Sources is a monitoring screen you come
 * back to.
 *
 * The "paste a URL yourself" route used to be a second option here. It is the
 * Webhook card now — one URL for any app, a Tally or Typeform form included —
 * which `onManual` opens for someone who would rather not share an API key.
 */
export const ConnectModal: React.FC<{
  /** The form provider's code, e.g. 'TALLY' or 'TYPEFORM'. */
  provider: string;
  onClose: () => void;
  /** A source now exists — refresh whatever list the caller is showing. */
  onConnected: (leadSourceId: string) => void;
  /** Jump to this source on the Lead Sources screen. */
  onOpenSource: (leadSourceId: string) => void;
  /** Set it up by hand instead: the webhook wizard. */
  onManual: () => void;
}> = ({ provider, onClose, onConnected, onOpenSource, onManual }) => {
  // Escape closes, and the page behind must not scroll under the overlay.
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
      <div
        className="w-full max-w-lg my-8"
        // The overlay closes on click; the card must not inherit that.
        onClick={(e) => e.stopPropagation()}
      >
        <ConnectFormPanel provider={provider} onClose={onClose} onConnected={onConnected} onOpenSource={onOpenSource} onSetUpManually={onManual} />
      </div>
    </div>
  );
};
