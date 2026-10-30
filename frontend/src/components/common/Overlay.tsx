import React, { useEffect } from 'react';
import { PanelClose } from '../leadsources/ManualWebhookPanel';

/**
 * The full-screen overlay the connection cards open their setup in. Escape, a
 * click outside or the close button closes it, and the page behind does not
 * scroll while it is open.
 */
export const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => {
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
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end mb-2">
          <PanelClose onClose={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
};
