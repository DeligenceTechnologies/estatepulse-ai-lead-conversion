import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RefLink } from '../../utils/assistantChatApi';

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

/** A ref the assistant writes in brackets after a record's name, with the space before it. */
const REF_TOKEN = /\s?\[([LUCMST][1-9]\d{0,5})\]/g;

export type Piece = string | { link: RefLink; label: string; bold: boolean } | { icon: RefLink };

/** Where the lead's name (or first name) ends the text, plain or in **bold**, as a whole word. */
function nameAtEnd(text: string, name: string): { start: number; label: string; bold: boolean } | null {
  const lower = text.toLowerCase();
  const first = name.split(/\s+/)[0];
  for (const candidate of name === first ? [name] : [name, first]) {
    for (const bold of [true, false]) {
      const written = bold ? `**${candidate}**` : candidate;
      if (!lower.endsWith(written.toLowerCase())) continue;
      const start = text.length - written.length;
      if (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) continue;
      return { start, label: text.slice(start + (bold ? 2 : 0), text.length - (bold ? 2 : 0)), bold };
    }
  }
  return null;
}

/**
 * Splits a line at the refs the assistant writes after names ("Maria Lopez [L1]"). The name of a
 * lead the chat knows becomes a link and the ref is hidden; a known lead whose name is not right
 * before its ref gets a small link instead; any other ref (made up, a team member, one the user can
 * no longer see) is simply dropped.
 */
export function linkRefs(line: string, refs: Record<string, RefLink>): Piece[] {
  // "**Maria Lopez [L1]**" reads as "**Maria Lopez** [L1]".
  const text = line.replace(/\*\*([^*]*?)\s?\[([LUCMST][1-9]\d{0,5})\]\*\*/g, '**$1** [$2]');
  const pieces: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const before = text.slice(last, m.index);
    last = m.index + m[0].length;
    const link = refs[m[1]];
    const hit = link ? nameAtEnd(before, link.name) : null;
    if (link && hit) {
      if (hit.start > 0) pieces.push(before.slice(0, hit.start));
      pieces.push({ link, label: hit.label, bold: hit.bold });
    } else {
      if (before) pieces.push(before);
      if (link) pieces.push({ icon: link });
    }
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

const leadPath = (link: RefLink) => `/leads?lead=${encodeURIComponent(link.id)}`;

/** `**bold**` inside plain text. */
const Bold: React.FC<{ text: string }> = ({ text }) => (
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

/** A line: bold, and links for the leads it names. */
const Inline: React.FC<{ text: string; refs: Record<string, RefLink> }> = ({ text, refs }) => (
  <>
    {linkRefs(text, refs).map((piece, i) =>
      typeof piece === 'string' ? (
        <Bold key={i} text={piece} />
      ) : 'link' in piece ? (
        <Link
          key={i}
          to={leadPath(piece.link)}
          className={`${piece.bold ? 'font-semibold text-white' : 'font-medium text-emerald-300'} underline decoration-emerald-500/40 underline-offset-2 hover:decoration-emerald-400`}
        >
          {piece.label}
        </Link>
      ) : (
        <Link key={i} to={leadPath(piece.icon)} title={`Open ${piece.icon.name}`} aria-label={`Open ${piece.icon.name}`} className="inline-flex align-middle text-emerald-300 hover:text-emerald-200">
          <ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      ),
    )}
  </>
);

const NO_REFS: Record<string, RefLink> = {};

export const RichText: React.FC<{ text: string; className?: string; refs?: Record<string, RefLink> }> = ({ text, className = '', refs = NO_REFS }) => (
  <div className={`space-y-2 text-sm text-slate-200 leading-relaxed break-words ${className}`}>
    {blocksOf(text).map((b, i) =>
      b.kind === 'p' ? (
        <p key={i} className="whitespace-pre-wrap">
          {b.lines.map((line, j) => (
            <React.Fragment key={j}>
              {j > 0 && '\n'}
              <Inline text={line} refs={refs} />
            </React.Fragment>
          ))}
        </p>
      ) : (
        React.createElement(
          b.kind,
          { key: i, className: `${b.kind === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-1 marker:text-slate-500` },
          b.items.map((item, j) => (
            <li key={j}>
              <Inline text={item} refs={refs} />
            </li>
          )),
        )
      ),
    )}
  </div>
);
