import React from 'react';
import { Eye } from 'lucide-react';
import type { BusinessDetailsView } from '../../utils/smsConversationApi';
import { previewTemplate, smsSize, withOutreachFooter, type SmsSize } from '../../utils/smsCompliance';

const sizeLabel = (s: SmsSize) => `${s.segments} SMS${s.encoding === 'UCS-2' ? ` · "${s.culprit}" makes it UCS-2 (70 characters a text)` : ''}`;

/**
 * What a lead receives from an outreach text: the template filled in for a
 * sample lead, with what the system adds so the text says who is texting and
 * how to stop. `first`: this step is normally the first text to a number.
 */
export const SmsPreview: React.FC<{ template: string; first: boolean; details: BusinessDetailsView | null }> = ({ template, first, details }) => {
  if (!template.trim()) return null;
  const brokerage = details?.brokerage || 'Your brokerage';
  const ourNumber = details?.ourNumber || '';
  const text = previewTemplate(template, brokerage);
  const shown = withOutreachFooter({ text, brokerage, ourNumber, canadian: false, firstText: first });
  const canadian = withOutreachFooter({ text, brokerage, ourNumber, canadian: true, firstText: first });
  const firstText = withOutreachFooter({ text, brokerage, ourNumber, canadian: false, firstText: true });
  const added = (full: string) => full.slice(text.length).trim();

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-2xs text-slate-500">
        <span className="flex items-center gap-1">
          <Eye className="w-3 h-3" />
          {first ? 'The lead receives (first text to their number)' : 'The lead receives'}
        </span>
        <span className={smsSize(shown).encoding === 'UCS-2' ? 'text-amber-400' : ''}>{sizeLabel(smsSize(shown))}</span>
      </div>
      <div className="whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">{shown}</div>
      {!first && added(firstText) && (
        <p className="text-2xs text-slate-500">If it is the first text to a number, “{added(firstText)}” is added.</p>
      )}
      {added(canadian) && (
        <p className="text-2xs text-slate-500">
          Canadian numbers get “{added(canadian)}” on every outreach text (Canada&apos;s anti-spam law): {sizeLabel(smsSize(canadian))}.
          {!ourNumber && ' Connect a Telnyx number to see it in full.'}
        </p>
      )}
    </div>
  );
};
