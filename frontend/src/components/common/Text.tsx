import React from 'react';

/**
 * The app's text components. They only pick the right tag and the matching
 * `type-*` class from typography.css, so every heading and paragraph shares
 * one size, weight and colour per role in both themes.
 *
 *   <Heading level={1}>Leads</Heading>                 page title
 *   <Heading level={3}>Recent calls</Heading>          card title
 *   <Heading level={2} as="h3">…</Heading>             h2 look, h3 tag
 *   <Text>Normal paragraph.</Text>
 *   <Text variant="muted">Supporting text.</Text>
 *   <Text variant="caption" as="span">2 min ago</Text>
 *
 * A className is appended, so layout (mt-1, truncate) and one-off colours
 * (text-rose-300) can still be added.
 */

type HeadingLevel = 1 | 2 | 3 | 4;

// Full class names, written out so Tailwind finds them when scanning.
const HEADING_CLASS: Record<HeadingLevel, string> = { 1: 'type-h1', 2: 'type-h2', 3: 'type-h3', 4: 'type-h4' };
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';

export interface HeadingProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** The look: 1 = page title, 2 = section, 3 = card title, 4 = small title. */
  level?: HeadingLevel;
  /** The tag, when it should differ from the look (defaults to h{level}). */
  as?: HeadingTag;
  /** Bigger than h1: hero numbers and landing headlines. */
  display?: boolean;
}

export const Heading: React.FC<HeadingProps> = ({ level = 2, as, display = false, className = '', ...rest }) => {
  const Tag = (as ?? `h${level}`) as React.ElementType;
  const role = display ? 'type-display' : HEADING_CLASS[level];
  return <Tag className={`${role} ${className}`.trim()} {...rest} />;
};

export type TextVariant = 'body' | 'body-sm' | 'muted' | 'caption' | 'label' | 'overline';

const TEXT_CLASS: Record<TextVariant, string> = {
  body: 'type-body',
  'body-sm': 'type-body-sm',
  muted: 'type-muted',
  caption: 'type-caption',
  label: 'type-label',
  overline: 'type-overline',
};

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  variant?: TextVariant;
  as?: 'p' | 'span' | 'div' | 'label' | 'small';
  /** For `as="label"`. */
  htmlFor?: string;
}

export const Text: React.FC<TextProps> = ({ variant = 'body', as, className = '', ...rest }) => {
  const Tag = (as ?? (variant === 'label' ? 'label' : 'p')) as React.ElementType;
  return <Tag className={`${TEXT_CLASS[variant]} ${className}`.trim()} {...rest} />;
};
