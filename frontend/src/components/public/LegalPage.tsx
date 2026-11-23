import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LEGAL_ENTITY, type LegalDocument } from '../../content/legal';
import { PublicFooter, PublicHeader } from './PublicChrome';

/**
 * One public legal document (/terms, /privacy): title, a table of contents and
 * its sections, inside the same header and footer as the home page.
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
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-emerald-500 selection:text-on-accent">
      <PublicHeader />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        <div className="space-y-3">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">{doc.title}</h1>
          <p className="text-xs text-slate-500">Last updated {LEGAL_ENTITY.lastUpdated}</p>
          <p className="text-sm text-slate-400 leading-relaxed">{doc.intro}</p>
        </div>

        <nav aria-label="On this page" className="mt-8 bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6">
          <h2 className="text-xs uppercase tracking-wider font-bold text-slate-300">On this page</h2>
          <ol className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-400">
            {doc.sections.map((section, i) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="hover:text-emerald-400 transition-colors">
                  {i + 1}. {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          {doc.sections.map((section, i) => (
            <section key={section.id} id={section.id} className="scroll-mt-24 space-y-3">
              <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                {i + 1}. {section.heading}
              </h2>
              {section.body.map((block, b) =>
                typeof block === 'string' ? (
                  <p key={b} className="text-sm text-slate-400 leading-relaxed">
                    {block}
                  </p>
                ) : (
                  <ul key={b} className="list-disc pl-5 space-y-1.5 text-sm text-slate-400 leading-relaxed marker:text-slate-600">
                    {block.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </section>
          ))}
        </div>

        <p className="mt-12 pt-6 border-t border-slate-800/70 text-sm text-slate-400">
          See also our{' '}
          <Link to={related.to} className="text-emerald-400 hover:text-emerald-300 font-medium">
            {related.label}
          </Link>
          .
        </p>
      </main>

      <PublicFooter />
    </div>
  );
};
