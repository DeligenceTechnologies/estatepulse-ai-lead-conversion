import { toast } from 'react-toastify';

/**
 * A yes/no question asked as a toast, in place of window.confirm.
 *
 * Stays open until a button is pressed; resolves false if the toast goes away
 * any other way, so a caller awaiting it is never left hanging.
 */
export const confirmToast = (message: string, confirmLabel = 'OK'): Promise<boolean> =>
  new Promise((resolve) => {
    let answered = false;
    const answer = (closeToast: () => void, ok: boolean) => {
      answered = true;
      resolve(ok);
      closeToast();
    };
    toast(
      ({ closeToast }) => (
        <div className="space-y-3">
          <p>{message}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(closeToast, false)}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => answer(closeToast, true)}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-on-accent text-xs font-bold transition-colors cursor-pointer"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      ),
      {
        position: 'top-center',
        autoClose: false,
        closeOnClick: false,
        closeButton: false,
        draggable: false,
        onClose: () => {
          if (!answered) resolve(false);
        },
      },
    );
  });
