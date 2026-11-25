import React from 'react';
import './landing.css';
import { LandingFooter } from './LandingFooter';
import { LandingNav } from './LandingNav';
import { useLandingLook } from './useLandingLook';

/**
 * The frame every public page shares — home, /terms, /privacy: the floating
 * nav with the theme button, the page, and the footer. The chosen look is
 * remembered on the device, so it carries from page to page.
 */
export const LandingShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { look, toggle } = useLandingLook();
  return (
    <div className="lp" data-look={look} id="top">
      <LandingNav look={look} onToggleLook={toggle} />
      {children}
      <LandingFooter />
    </div>
  );
};
