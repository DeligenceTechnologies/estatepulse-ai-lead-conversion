import React from 'react';

/**
 * A native <select> with the app's own arrow. The browser's arrow sits flush
 * against the border and differs per browser; this one (`.select-chevron` in
 * theme.css) is inset from the edge, centred, and follows the theme, and the
 * text never runs under it.
 *
 * It renders a bare <select> with no wrapper, so it drops into any layout a
 * plain <select> did: widths, flex and grid behave exactly as before.
 */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = '', ...rest }, ref) => (
    <select ref={ref} className={`${className} select-chevron`} {...rest} />
  ),
);
Select.displayName = 'Select';
