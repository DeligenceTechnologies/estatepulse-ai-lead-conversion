import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { FAQ_ITEMS } from '../../content/faq';

/**
 * The FAQ on the public home page: one question open at a time.
 *
 * A closed answer stays in the page with `hidden` rather than being unmounted,
 * so the whole text is there for search engines and for find-in-page.
 */
export const FaqSection: React.FC = () => {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section id="faq" className="border-y border-slate-800/70 bg-slate-900/30 scroll-mt-18">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 sm:py-20 space-y-10">
        <div className="space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Frequently asked questions</h2>
          <p className="text-sm text-slate-400">How EstatePulse works, before you sign up.</p>
        </div>

        <ul className="max-w-3xl bg-slate-900/90 border border-slate-800 rounded-2xl divide-y divide-slate-800 shadow-xl">
          {FAQ_ITEMS.map((item) => {
            const open = openId === item.id;
            const buttonId = `faq-${item.id}-question`;
            const panelId = `faq-${item.id}-answer`;
            return (
              <li key={item.id}>
                <h3>
                  <button
                    type="button"
                    id={buttonId}
                    onClick={() => setOpenId(open ? null : item.id)}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className="w-full flex items-center justify-between gap-4 px-5 sm:px-6 py-4 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400 rounded-2xl"
                  >
                    <span className="text-sm font-semibold text-white">{item.question}</span>
                    <ChevronDown
                      aria-hidden
                      className={`w-4 h-4 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
                    />
                  </button>
                </h3>
                <div id={panelId} role="region" aria-labelledby={buttonId} hidden={!open} className="px-5 sm:px-6 pb-5">
                  <p className="text-sm text-slate-400 leading-relaxed">{item.answer}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
};
