import React from 'react';
import { PRESETS, onlyIfText, presetOf, type ConditionContext, type OnlyIf } from '../../utils/conditions';

interface Props {
  value: OnlyIf | undefined;
  onChange: (next: OnlyIf) => void;
  context: ConditionContext;
  disabled?: boolean;
  className?: string;
}

const CUSTOM = '__custom';

/** When a step goes, as a plain choice. A condition set some other way before is listed as it is, so it is never lost unseen. */
export const ConditionSelect: React.FC<Props> = ({ value, onChange, context, disabled, className }) => {
  const preset = presetOf(value, context);
  const custom = preset ? null : onlyIfText(value);
  return (
    <div className="space-y-1">
      <select
        disabled={disabled}
        value={preset?.value ?? CUSTOM}
        onChange={(e) => {
          const next = PRESETS[context].find((p) => p.value === e.target.value);
          if (next) onChange(next.onlyIf);
        }}
        className={className}
      >
        {PRESETS[context].map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        {custom && <option value={CUSTOM}>{`Custom: ${custom}`}</option>}
      </select>
      {preset?.hint && <p className="text-2xs text-slate-500">{preset.hint}</p>}
    </div>
  );
};
