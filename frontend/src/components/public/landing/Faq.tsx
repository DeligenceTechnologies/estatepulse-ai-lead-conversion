import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { FAQ_ITEMS } from '../../../content/faq';

/**
 * The home page FAQ: master's question list (content/faq.ts) in the landing
 * page's numbered style. One answer open at a time, all closed to start.
 *
 * Closed answers stay in the page (collapsed, not unmounted) so the full text
 * is there for search engines and find-in-page.
 */
export const Faq: React.FC = () => {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="lp-faq">
      {FAQ_ITEMS.map((item, i) => {
        const isOpen = openId === item.id;
        const buttonId = `faq-${item.id}-question`;
        const panelId = `faq-${item.id}-answer`;
        return (
          <div key={item.id} className={`lp-faq-item ${isOpen ? 'is-open' : ''}`}>
            <h3>
              <button
                type="button"
                id={buttonId}
                className="lp-faq-q"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
              >
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                {item.question}
                <span className="lp-pm">
                  <Plus />
                </span>
              </button>
            </h3>
            <div className="lp-faq-a" id={panelId} role="region" aria-labelledby={buttonId} aria-hidden={!isOpen}>
              <div>
                <p>{item.answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
