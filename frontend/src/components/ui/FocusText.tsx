import { m } from 'motion/react';
import type { ElementType } from 'react';
import { ease } from './motion';

interface FocusTextProps {
  text: string;
  as?: 'h1' | 'h2' | 'p' | 'span';
  className?: string;
  /** Seconds before the first word starts. */
  delay?: number;
  /** Seconds between words. */
  stagger?: number;
  id?: string;
}

/**
 * A line of text that comes into focus word by word — each word arrives soft
 * and settles sharp, like a projectionist pulling focus on a title card.
 *
 * The full string stays in the accessible name (aria-label on the element),
 * and the animated words are hidden from assistive tech, so a screen reader
 * hears the sentence once rather than word-by-word fragments.
 */
export function FocusText({ text, as = 'h1', className, delay = 0, stagger = 0.08, id }: FocusTextProps) {
  const Tag = m[as] as ElementType;
  const words = text.split(' ');
  return (
    <Tag
      id={id}
      className={className}
      aria-label={text}
      initial="hidden"
      animate="shown"
      variants={{ hidden: {}, shown: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
    >
      {words.map((word, i) => (
        <m.span
          key={`${word}-${i}`}
          aria-hidden="true"
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
          variants={{
            hidden: { opacity: 0, y: '0.18em', filter: 'blur(12px)', scale: 1.06 },
            shown: {
              opacity: 1,
              y: 0,
              filter: 'blur(0px)',
              scale: 1,
              transition: { duration: 0.9, ease: ease.out },
            },
          }}
        >
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </m.span>
      ))}
    </Tag>
  );
}
