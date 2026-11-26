import React, { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Feedback, FeedbackReason } from '../../utils/assistantChatApi';
import { Button } from '../common/Button';

export const FEEDBACK_REASONS: { key: FeedbackReason; label: string }[] = [
  { key: 'wrong', label: 'Wrong or made up' },
  { key: 'not_done', label: "Didn't do what I asked" },
  { key: 'unclear', label: 'Hard to follow' },
  { key: 'other', label: 'Something else' },
];

const thumbClass = (on: boolean) =>
  `inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors cursor-pointer ${
    on ? 'bg-slate-800 text-emerald-300' : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'
  }`;

/**
 * Thumbs up or down under an answer. The rating saves on click, and clicking the same thumb again
 * takes it back. A thumbs down opens an optional "what went wrong": a reason and a comment.
 */
export const AnswerFeedback: React.FC<{ feedback?: Feedback; onRate: (feedback: Feedback | null) => Promise<boolean> }> = ({ feedback, onRate }) => {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | null>(feedback?.reason ?? null);
  const [comment, setComment] = useState(feedback?.comment ?? '');
  const [thanked, setThanked] = useState(false);
  const rating = feedback?.rating;

  const thumb = (pick: 'up' | 'down') => {
    setThanked(false);
    if (rating === pick) {
      setOpen(false);
      void onRate(null);
      return;
    }
    setOpen(pick === 'down');
    void onRate(pick === 'down' ? { rating: 'down', reason, comment: comment.trim() || null } : { rating: 'up', reason: null, comment: null }).then(
      (ok) => ok && pick === 'up' && setThanked(true),
    );
  };

  const send = async () => {
    if (await onRate({ rating: 'down', reason, comment: comment.trim() || null })) {
      setOpen(false);
      setThanked(true);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-0.5">
        <button type="button" aria-label="Good answer" aria-pressed={rating === 'up'} title="Good answer" onClick={() => thumb('up')} className={thumbClass(rating === 'up')}>
          <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button type="button" aria-label="Bad answer" aria-pressed={rating === 'down'} title="Bad answer" onClick={() => thumb('down')} className={thumbClass(rating === 'down')}>
          <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
        </button>
        {thanked && <span className="ml-1.5 text-2xs text-slate-500">Thanks, this helps us improve.</span>}
      </div>
      {open && rating === 'down' && (
        <div className="space-y-2.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <p className="text-xs font-semibold text-slate-300">What went wrong? (optional)</p>
          <div className="flex flex-wrap gap-1.5">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={reason === r.key}
                onClick={() => setReason(reason === r.key ? null : r.key)}
                className={`cursor-pointer rounded-full border px-2.5 py-1 text-2xs font-medium transition-colors ${
                  reason === r.key ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200' : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Tell us more"
            aria-label="What went wrong"
            className="w-full resize-none rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Skip
            </Button>
            <Button size="sm" onClick={() => void send()}>
              Send feedback
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
