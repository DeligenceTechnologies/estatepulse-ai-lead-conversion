import React, { useRef, useState } from 'react';
import { motion, useMotionValueEvent, useReducedMotion, useScroll } from 'motion/react';
import { CalendarCheck, FileText, MessageSquare, PhoneCall, Send, UserCheck } from 'lucide-react';

const STEPS = [
  { when: '0:00', title: 'Form submitted', body: 'The lead appears in EstatePulse with its source, ready to work.', Icon: FileText },
  { when: 'Right away', title: 'A text goes out', body: 'A short intro from your number, so the call that follows isn’t a surprise.', Icon: Send },
  { when: 'About a minute later', title: 'The AI calls', body: 'It asks the qualifying questions and writes each answer onto the lead.', Icon: PhoneCall },
  { when: 'On the call', title: 'Meeting booked', body: 'It checks Calendly for a free slot and books the consultation.', Icon: CalendarCheck },
  { when: 'After the call', title: 'Agent assigned', body: 'The lead goes to the agent who covers that area and has room for it.', Icon: UserCheck },
  { when: 'If they don’t pick up', title: 'Follow-ups keep going', body: 'Texts and retries follow the steps and hours you set.', Icon: MessageSquare },
];

/** The line fills as you scroll; each step lights up as the fill reaches it. */
export const LeadTimeline: React.FC = () => {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.65', 'end 0.65'] });
  const [lit, setLit] = useState(reduce ? STEPS.length : 0);

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    if (reduce) return;
    const next = Math.min(STEPS.length, Math.floor(p * STEPS.length + 0.35));
    setLit((prev) => (prev === next ? prev : next));
  });

  return (
    <>
      <ol ref={ref} className="lp-tl">
        <li className="lp-tl-line" aria-hidden>
          <motion.i style={{ scaleY: reduce ? 1 : scrollYProgress }} />
        </li>
        {STEPS.map(({ when, title, body, Icon }, i) => (
          <li key={title} className={`lp-tl-step ${i < lit ? 'is-lit' : ''}`}>
            <span className="lp-tl-dot">
              <Icon />
            </span>
            <div>
              <span className="lp-tl-when">{when}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="lp-tl-note">Timing shown is the setup from our demo. You choose the steps, the gaps and the contact hours.</p>
    </>
  );
};
