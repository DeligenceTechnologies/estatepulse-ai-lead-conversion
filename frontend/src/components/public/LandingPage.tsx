import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Check, ClipboardList, Eye, Send, ShieldCheck } from 'lucide-react';
import { CallDemo } from './landing/CallDemo';
import { Faq } from './landing/Faq';
import { FeatureAccordion } from './landing/FeatureAccordion';
import { Hero } from './landing/Hero';
import { LandingShell } from './landing/LandingShell';
import { LeadTimeline } from './landing/LeadTimeline';
import { OldWayNewWay } from './landing/OldWayNewWay';
import { Reveal } from './landing/Reveal';
import { SourcesMarquee } from './landing/SourcesMarquee';

/**
 * The public home page, shown at `/` to anyone who is not signed in.
 *
 * Claims only what the product does today: lead capture from real sources, an
 * AI qualification call, follow-ups, booking and handoff to an agent. No
 * invented metrics, testimonials, customer logos or pricing. The example lead
 * and the scripted call are labelled as examples.
 *
 * Styling lives in landing/landing.css, scoped to `.lp`. Midnight is the
 * default look; the nav's theme button switches to Beige + Terracotta.
 */

const TRUST = [
  { title: 'Isolated per organization', body: 'Each office’s data is separated at the database level.', Icon: ShieldCheck },
  { title: 'Agents see their own leads', body: 'Owners see the whole pipeline. Agents see what’s assigned to them.', Icon: Eye },
  { title: 'Audit trail', body: 'Every assignment records why that agent was chosen, and an unassigned lead always shows the reason.', Icon: ClipboardList },
  { title: 'Delivery log', body: 'Each lead source keeps a log of what arrived and when, so a missing lead is a lookup, not a guess.', Icon: Send },
];

export const LandingPage: React.FC = () => {
  const { hash, key } = useLocation();

  // The router does not scroll to a hash itself (e.g. /#faq from /terms). `key`
  // changes on every navigation, so the same link works twice in a row.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash, key]);

  return (
    <LandingShell>

      <main>
        <Hero />
        <SourcesMarquee />
        <OldWayNewWay />

        <section className="lp-feat-band" id="product">
          <div className="lp-wrap">
            <div className="lp-feat-panel">
              <div className="lp-wrap">
                <Reveal className="lp-sec-head">
                  <span className="lp-eyebrow">The product</span>
                  <h2 className="lp-h2">Everything between “form submitted” and “meeting booked”.</h2>
                </Reveal>
                <Reveal delay={0.05}>
                  <FeatureAccordion />
                </Reveal>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section lp-call-band" aria-label="Example AI call">
          <div className="lp-wrap lp-call-grid">
            <Reveal>
              <div className="lp-sec-head" style={{ marginBottom: 0 }}>
                <span className="lp-eyebrow">Example call</span>
                <h2 className="lp-h2">Hear what the AI asks.</h2>
                <p className="lp-lede">
                  The questions your best agent would ask on a first call. Every answer lands on the lead record while
                  the call is still going.
                </p>
              </div>
              <ul className="lp-call-points">
                <li>
                  <Check />
                  Area, budget, timeline, property type and financing
                </li>
                <li>
                  <Check />
                  Offers a consultation and books it from your calendar
                </li>
                <li>
                  <Check />
                  Live transfer to an agent when the lead wants a person
                </li>
              </ul>
            </Reveal>
            <Reveal delay={0.08}>
              <CallDemo />
            </Reveal>
          </div>
        </section>

        <section className="lp-section" aria-label="A lead's first minutes">
          <div className="lp-wrap">
            <Reveal className="lp-sec-head center">
              <span className="lp-eyebrow">A lead’s first minutes</span>
              <h2 className="lp-h2">What happens after someone hits “Submit”.</h2>
            </Reveal>
            <LeadTimeline />
          </div>
        </section>

        <section className="lp-section lp-trust" aria-label="Built for teams">
          <div className="lp-wrap">
            <Reveal className="lp-sec-head">
              <span className="lp-eyebrow">Built for teams</span>
              <h2 className="lp-h2">Your leads stay yours.</h2>
            </Reveal>
            <ul className="lp-trust-grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {TRUST.map(({ title, body, Icon }, i) => (
                <Reveal as="li" key={title} delay={i * 0.06}>
                  <div className="lp-tcard">
                    <Icon />
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </Reveal>
              ))}
            </ul>
          </div>
        </section>

        <section className="lp-section" id="faq" aria-label="FAQ">
          <div className="lp-wrap">
            <Reveal className="lp-sec-head center">
              <span className="lp-eyebrow">FAQ</span>
              <h2 className="lp-h2">Frequently asked questions</h2>
              <p className="lp-lede">How EstatePulse works, before you sign up.</p>
            </Reveal>
            <Reveal delay={0.05}>
              <Faq />
            </Reveal>
          </div>
        </section>
      </main>

    </LandingShell>
  );
};
