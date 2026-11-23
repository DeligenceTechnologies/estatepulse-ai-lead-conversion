import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Palette } from 'lucide-react';
import { pathForView } from '../../context/AppContext';
import { Drawer } from '../calendar/shared/Drawer';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { IconButton } from '../common/Button';

/**
 * The navbar's Appearance button. Where the shell has a Settings page (the
 * owner app) it opens Settings → Appearance; elsewhere (the agent app) it
 * opens the same settings in a drawer.
 */
export const AppearanceButton: React.FC<{ hasSettings: boolean }> = ({ hasSettings }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const onClick = (): void => {
    if (hasSettings) navigate({ pathname: pathForView('settings'), search: '?tab=appearance' });
    else setOpen(true);
  };

  return (
    <>
      <IconButton onClick={onClick} aria-label="Appearance" title="Appearance" icon={<Palette />} />
      {/* Portalled to <body>: the navbar's backdrop-filter would otherwise trap the fixed overlay. */}
      {open &&
        createPortal(
          <Drawer
            icon={Palette}
            title="Appearance"
            hint="Theme, brand colour and buttons. Changes apply instantly."
            width="xl"
            onClose={close}
          >
            <AppearanceSettings />
          </Drawer>,
          document.body,
        )}
    </>
  );
};
