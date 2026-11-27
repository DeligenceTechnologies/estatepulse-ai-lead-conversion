import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LEGAL_ENTITY, type LegalDocument } from '../../content/legal';
import { LandingShell } from './landing/LandingShell';

/**
 * One public legal document (/terms, /privacy): title, a table of contents and
 * its sections, inside the same nav, theme and footer as the home page.
 */
export const LegalPage: React.FC<{
  doc: LegalDocument;
  /** The other legal document, linked at the foot of this one. */
  related: { to: string; label: string };
}> = ({ doc, related }) => {
  const { hash } = useLocation();

  // The router keeps the previous page's scroll position, so a footer link
  // would open this page part-way down. A link to a section goes to it instead.
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [doc, hash]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${doc.title} · ${LEGAL_ENTITY.productName}`;
    return () => {
      document.title = previous;
    };
  }, [doc]);

  return (
    <LandingShell>
      <main className="lp-wrap lp-legal">
        <div className="lp-legal-head">
          <span className="lp-eyebrow">Legal</span>
          <h1 className="lp-h2">{doc.title}</h1>
          <p className="lp-legal-date">Last updated {LEGAL_ENTITY.lastUpdated}</p>
          <p className="lp-lede">{doc.intro}</p>
        </div>

        <nav aria-label="On this page" className="lp-legal-toc">
          <h2>On this page</h2>
          <ol>
            {doc.sections.map((section, i) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="lp-legal-body">
          {doc.sections.map((section, i) => (
            <section id={section.id} key={section.id}>
              <h2>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                {section.heading}
              </h2>
              {section.body.map((block, b) =>
                typeof block === 'string' ? (
                  <p key={b}>{block}</p>
                ) : (
                  <ul key={b}>
                    {block.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </section>
          ))}
        </div>

        <p className="lp-legal-related">
          See also our <Link to={related.to}>{related.label}</Link>.
        </p>
      </main>
    </LandingShell>
  );
};
