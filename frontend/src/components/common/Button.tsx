import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * The app's one button.
 *
 * Every action button — a modal's Save / Cancel, a card's Connect, a toolbar's
 * Export — is this component, so they share one height per size, one radius,
 * one focus ring and one disabled / busy treatment in both themes. Things that
 * only look button-ish (nav rows, tabs, segmented pickers, switches, list rows,
 * menu items) keep their own markup.
 *
 * Variants:
 * - primary      the one main action of a screen, form or modal
 * - secondary    every other action next to it (Cancel, Back, Export)
 * - outline      a quieter secondary on a busy surface (toolbars, cards)
 * - ghost        low-emphasis actions, no chrome until hover
 * - danger       a destructive action that is the main one (Delete in a confirm)
 * - danger-soft  a destructive action that is not (Disconnect, Remove)
 * - link         inline text action, no height or padding
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-soft' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

// Radius and focus-ring colour live in the variants, so no two classes on one
// button ever set the same property. A caller's className can then add layout
// (flex-1, ml-auto, mt-3) freely; anything that must beat the base takes
// Tailwind's important suffix (`flex!`, `h-auto!`).
const BASE =
  'inline-flex items-center justify-center gap-1.5 shrink-0 whitespace-nowrap font-semibold ' +
  'transition-colors cursor-pointer select-none focus:outline-none focus-visible:ring-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none';

// Every boxed variant has a 1px border (transparent where it has no visible
// one), so a primary and a secondary of the same size are exactly the same box.
// `rounded-button` follows Settings → Appearance → Button shape; `btn-solid`
// marks the filled variants so Button style (solid / gradient / glow) can
// restyle them from theme.css.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'btn-solid rounded-button border border-transparent bg-brand-600 text-on-accent shadow-sm hover:bg-brand-500 active:bg-brand-700 focus-visible:ring-brand-500/50',
  secondary:
    'rounded-button border border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700 hover:text-neutral-100 focus-visible:ring-brand-500/50',
  outline:
    'rounded-button border border-neutral-700 bg-transparent text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-brand-500/50',
  ghost:
    'rounded-button border border-transparent bg-transparent text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-brand-500/50',
  danger:
    'btn-solid btn-danger rounded-button border border-transparent bg-danger-600 text-on-accent shadow-sm hover:bg-danger-500 active:bg-danger-700 focus-visible:ring-danger-500/50',
  'danger-soft':
    'rounded-button border border-danger-500/30 bg-danger-500/10 text-danger-300 hover:bg-danger-500/20 hover:text-danger-200 focus-visible:ring-danger-500/50',
  link: 'rounded text-brand-400 hover:text-brand-300 hover:underline underline-offset-2 focus-visible:ring-brand-500/50',
};

/** Fixed heights, so buttons line up with each other and with inputs (h-9). */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-xs',
  lg: 'h-10 px-5 text-sm',
};

const ICON_SIZES: Record<ButtonSize, string> = {
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-4 h-4',
};

/** The classes alone, for a link or label that has to look like a button. */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  className = '',
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}): string {
  const sizing = variant === 'link' ? 'text-xs' : SIZES[size];
  return [BASE, VARIANTS[variant], sizing, fullWidth ? 'w-full' : '', className].filter(Boolean).join(' ');
}

export interface ButtonProps extends React.ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A lucide icon element; it is sized to the button. */
  icon?: React.ReactElement<{ className?: string }>;
  iconRight?: React.ReactElement<{ className?: string }>;
  /** Shows a spinner in place of the icon and blocks clicks. */
  loading?: boolean;
  fullWidth?: boolean;
}

// The button owns its icon's size: any w-/h- the caller left on it is dropped,
// so the two never fight over which class wins.
const ownSize = (cls: string | undefined) =>
  (cls ?? '')
    .split(/\s+/)
    .filter((c) => c && !/^(w|h|size)-/.test(c))
    .join(' ');

const sized = (el: React.ReactElement<{ className?: string }> | undefined, size: ButtonSize) =>
  el &&
  React.cloneElement(el, {
    className: `${ICON_SIZES[size]} shrink-0 ${ownSize(el.props.className)}`.trim(),
    'aria-hidden': true,
  } as React.Attributes & { className: string });

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  fullWidth = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={buttonClass({ variant, size, fullWidth, className })}
    {...rest}
  >
    {loading ? <Loader2 className={`${ICON_SIZES[size]} shrink-0 animate-spin`} aria-hidden /> : sized(icon, size)}
    {children}
    {sized(iconRight, size)}
  </button>
);

/** Square, and the same height as a text Button of the same size. */
const ICON_BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'w-8 h-8',
  md: 'w-9 h-9',
  lg: 'w-10 h-10',
};

export interface IconButtonProps extends Omit<ButtonProps, 'iconRight' | 'fullWidth' | 'children' | 'icon'> {
  icon: React.ReactElement<{ className?: string }>;
  /** Required: an icon-only button has no other accessible name. */
  'aria-label': string;
}

/** A square icon-only button (close, edit, copy, more). Defaults to ghost. */
export const IconButton: React.FC<IconButtonProps> = ({
  variant = 'ghost',
  size = 'md',
  icon,
  loading = false,
  disabled,
  type = 'button',
  className = '',
  title,
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    title={title ?? rest['aria-label']}
    className={[BASE, VARIANTS[variant], ICON_BUTTON_SIZES[size], 'p-0', className].filter(Boolean).join(' ')}
    {...rest}
  >
    {loading ? (
      <Loader2 className={`${ICON_SIZES[size]} animate-spin`} aria-hidden />
    ) : (
      sized(icon, size)
    )}
  </button>
);
