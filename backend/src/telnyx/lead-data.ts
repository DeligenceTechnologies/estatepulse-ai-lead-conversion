/**
 * Lead details come from web forms, sheets and CRMs that anyone can fill in,
 * so they are data, never words we vouch for. Before a detail goes into a
 * text we send or into the AI's prompt, control and invisible characters are
 * taken out, links are removed and its length is capped. A name that does not
 * look like a name is dropped: "Hi there" rather than "Hi Visit bit.ly/x".
 */

/** Zero-width characters, soft hyphens and direction overrides, which hide or reorder text: taken out. */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
/** Control characters, line breaks and tabs among them: each becomes a space. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ly|co|ca|us|in|info|biz|me|xyz|link|app|site|online|top|click|gl|gg|ru|cn|tk)\b(?:\/\S*)?/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

export const NAME_MAX = 40;
const NAME_WORDS = 4;
/** Letters (any script) with the marks, spaces, apostrophes, hyphens and dots names have. */
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}'’ .-]*$/u;

/** One line: invisible characters out, any run of spaces, line breaks or control characters as one space. */
const oneLine = (raw: unknown): string =>
  String(raw ?? '')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** A first or last name as it may be said or texted, or '' when the field holds something else. */
export function safeName(raw: unknown): string {
  const name = oneLine(raw);
  if (!name || name.length > NAME_MAX || name.split(' ').length > NAME_WORDS) return '';
  if (EMAIL.test(name) || new RegExp(LINK.source, 'i').test(name) || !NAME.test(name)) return '';
  return name;
}

/** A free-text detail (location, timeline, motivation): one line, links removed, at most `max` characters. */
export function safeText(raw: unknown, max: number): string {
  const text = oneLine(raw).replace(LINK, '[link removed]').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** Every link in a text: "https://…", "www.…" or a bare domain such as bit.ly/x. */
export const linksIn = (text: string): string[] => text.match(LINK) ?? [];

/** Something texted, for the transcript the AI reads: the words as said, on one line, invisible characters out. Links stay: they are part of what was said. */
export const safeTranscript = (raw: unknown): string => oneLine(raw);
