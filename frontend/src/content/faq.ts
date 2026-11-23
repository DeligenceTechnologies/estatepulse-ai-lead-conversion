/**
 * Questions and answers for the FAQ section of the public home page.
 *
 * Same rule as the rest of that page: every answer describes what the product
 * does today. No pricing, trial or refund answers until those are published.
 */
export interface FaqItem {
  /** Used in element ids, unique within the list. */
  id: string;
  question: string;
  answer: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: 'what-is-it',
    question: 'What is EstatePulse AI?',
    answer:
      'EstatePulse AI is a lead conversion tool for real estate teams. When a new lead comes in, an AI voice call goes out, asks what the buyer is looking for, and hands qualified leads to the agent who covers that area.',
  },
  {
    id: 'lead-sources',
    question: 'How do leads get into EstatePulse?',
    answer:
      'You connect the forms your leads already come through, such as Tally or Typeform, or upload a CSV or Excel file. Every delivery is logged, so you can see what arrived and when.',
  },
  {
    id: 'call-questions',
    question: 'What does the AI ask on the call?',
    answer:
      'It confirms the lead is looking to buy, then asks about budget, preferred area, timeline and why they are moving. The answers and a summary of the call are saved on the lead record for your agent.',
  },
  {
    id: 'ai-disclosure',
    question: 'Does the lead know they are talking to an AI?',
    answer:
      'Yes. The default greeting says it is an AI assistant calling on behalf of your business, and the assistant is instructed never to claim to be a person. By default calls are recorded, and the lead hears a notice before the recording starts.',
  },
  {
    id: 'calling-hours',
    question: 'When are calls and texts sent?',
    answer:
      "Automated calls and texts follow each lead's own time zone and are held outside the calling hours for where the lead is. You can add your own quiet hours on top.",
  },
  {
    id: 'opt-out',
    question: 'What happens if a lead asks not to be contacted?',
    answer:
      'A lead who replies STOP to a text is unsubscribed, and a lead who asks on a call not to be contacted again is marked do-not-contact. Automated calls and texts to that number stop.',
  },
  {
    id: 'assignment',
    question: 'How is a lead assigned to an agent?',
    answer:
      'You set each agent’s territories, working hours and how many live leads they should carry. A qualified lead goes to an agent who covers that area and has room, and every assignment records why that agent was chosen.',
  },
  {
    id: 'phone-provider',
    question: 'Do I need my own phone provider?',
    answer:
      'Yes. EstatePulse places calls and texts through Telnyx, using a Telnyx account that you connect. Your phone numbers and usage are billed to you by Telnyx.',
  },
  {
    id: 'texting-and-booking',
    question: 'Can EstatePulse text leads and book meetings?',
    answer:
      'Yes. It can text leads and reply to their messages, and when you connect a scheduling tool such as Calendly the assistant can offer to book a consultation with an agent.',
  },
  {
    id: 'data-separation',
    question: 'Is my data kept separate from other offices?',
    answer:
      'Yes. Each organization is isolated at the database level, and an agent only ever sees the leads assigned to them.',
  },
];
