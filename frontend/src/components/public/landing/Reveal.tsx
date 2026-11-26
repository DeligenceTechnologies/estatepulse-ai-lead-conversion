import React from 'react';
import { motion, useReducedMotion } from 'motion/react';

interface RevealProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  /** Render as a list item when used directly inside <ol>/<ul>. */
  as?: 'div' | 'li';
}

/** Fades and lifts its children in the first time they scroll into view. */
export const Reveal: React.FC<RevealProps> = ({ children, delay = 0, className, as = 'div' }) => {
  const reduce = useReducedMotion();
  const Tag = as === 'li' ? motion.li : motion.div;
  return (
    <Tag
      className={className}
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, delay, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </Tag>
  );
};
