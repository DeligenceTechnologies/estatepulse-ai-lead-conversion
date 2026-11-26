import React, { useState } from 'react';
import { ConsentReviewPanel } from '../leads/ConsentReviewPanel';

/** Leads added by hand without consent. Nothing contacts them until a person decides. */
export const ConsentReviewView: React.FC = () => {
  const [total, setTotal] = useState(0);
  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto text-slate-100">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight">Consent Review</h2>
        <p className="text-xs text-slate-400">
          {total} lead{total === 1 ? '' : 's'} waiting for consent. Nothing contacts them until you decide.
        </p>
      </div>
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-lg p-4">
        <ConsentReviewPanel onTotal={setTotal} />
      </div>
    </div>
  );
};
