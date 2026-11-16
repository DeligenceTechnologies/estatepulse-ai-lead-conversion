import { toast } from 'react-toastify';
import { Button } from '../components/common/Button';

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
            <Button variant="outline" size="sm" onClick={() => answer(closeToast, false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => answer(closeToast, true)}>
              {confirmLabel}
            </Button>
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
