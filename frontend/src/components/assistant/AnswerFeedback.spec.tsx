import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AnswerFeedback } from './AnswerFeedback';
import { DRAFT_ID, type ChatMessage } from './AssistantProvider';
import { ChatMessages } from './ChatMessages';

const answer = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'msg-a', role: 'assistant', text: 'You have 6 new leads.', createdAt: '2026-11-26T10:00:00Z', actions: [], ...over });
const rate = async () => true;
const thumbs = (html: string) => (html.match(/aria-label="Good answer"/g) ?? []).length;
const render = (messages: ChatMessage[], withRate = true) =>
  renderToString(
    <MemoryRouter>
      <ChatMessages messages={messages} busy={false} onDecide={() => undefined} onRate={withRate ? rate : undefined} />
    </MemoryRouter>,
  );

describe('thumbs under answers', () => {
  it('shows them under each saved answer, not under questions or the answer being written', () => {
    const html = render([
      { id: 'local-1', role: 'user', text: 'How many new leads?', createdAt: '', actions: [] },
      answer(),
      answer({ id: 'msg-b', text: 'Done.' }),
      answer({ id: DRAFT_ID, text: 'Writing', pending: true }),
    ]);
    expect(thumbs(html)).toBe(2);
  });

  it('shows none without a way to save them, or on an answer with no text', () => {
    expect(thumbs(render([answer()], false))).toBe(0);
    expect(thumbs(render([answer({ text: '' })]))).toBe(0);
  });

  it('marks the rating already given', () => {
    const down = renderToString(<AnswerFeedback feedback={{ rating: 'down', reason: 'wrong', comment: null }} onRate={rate} />);
    expect(down).toMatch(/aria-label="Bad answer" aria-pressed="true"/);
    expect(down).toMatch(/aria-label="Good answer" aria-pressed="false"/);
    // The "what went wrong" box opens on a click, not for a rating loaded with the chat.
    expect(down).not.toContain('What went wrong');
  });
});
