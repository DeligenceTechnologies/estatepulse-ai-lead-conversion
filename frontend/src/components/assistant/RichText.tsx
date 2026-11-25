import React from 'react';

export type TextBlock = { kind: 'p'; lines: string[] } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Splits a reply into paragraphs and lists. The assistant is told to write plain text with short
 * "- " lists, so that and **bold** are all this understands; anything else shows as written.
 */
export function blocksOf(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  // Typed through `as` so TypeScript does not narrow it to null: close() reassigns it.
  let current = null as TextBlock | null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) {
      close();
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)![1];
      if (current?.kind !== kind) {
        close();
        current = { kind, items: [] };
      }
      (current as { items: string[] }).items.push(item);
      continue;
    }
    if (current?.kind !== 'p') {
      close();
      current = { kind: 'p', lines: [] };
    }
    (current as { lines: string[] }).lines.push(line);
  }
  close();
  return blocks;
}

/** `**bold**` inside a line. */
const Inline: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
        <strong key={i} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    )}
  </>
);

export const RichText: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => (
  <div className={`space-y-2 text-sm text-slate-200 leading-relaxed break-words ${className}`}>
    {blocksOf(text).map((b, i) =>
      b.kind === 'p' ? (
        <p key={i} className="whitespace-pre-wrap">
          {b.lines.map((line, j) => (
            <React.Fragment key={j}>
              {j > 0 && '\n'}
              <Inline text={line} />
            </React.Fragment>
          ))}
        </p>
      ) : (
        React.createElement(
          b.kind,
          { key: i, className: `${b.kind === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-1 marker:text-slate-500` },
          b.items.map((item, j) => (
            <li key={j}>
              <Inline text={item} />
            </li>
          )),
        )
      ),
    )}
  </div>
);
