import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Save } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection, type SetupResource } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { Select } from '../../common/Select';
import { Notice } from '../../calendar/shared/ui';

/** Lead fields a form question can fill, in the order the form shows them. Mirrors tally.mapping.ts and typeform.mapping.ts. */
export const LEAD_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'fullName', label: 'Full name', hint: 'Split into first and last name' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone', hint: 'Needs the country code, e.g. +91' },
  { key: 'location', label: 'Location' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'minBudget', label: 'Budget (min)' },
  { key: 'maxBudget', label: 'Budget (max)' },
  { key: 'bedrooms', label: 'Bedrooms' },
  { key: 'motivation', label: 'Notes' },
];

interface FormDetail {
  status: string | null;
  submissions: number | null;
  closed: boolean;
}

interface QuestionDetail {
  type: string;
  targets: string[];
  suggested: string | null;
}

const questionDetail = (q: SetupResource): QuestionDetail => q.detail as unknown as QuestionDetail;

const suggestedMap = (questions: SetupResource[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const q of questions) {
    const target = questionDetail(q).suggested;
    if (target) map[target] = q.id;
  }
  return map;
};

const formLabel = (f: SetupResource): string => {
  const d = f.detail as unknown as FormDetail | undefined;
  const bits = [d?.status === 'DRAFT' ? 'draft' : null, d?.closed ? 'closed' : null, typeof d?.submissions === 'number' ? `${d.submissions} submissions` : null].filter(Boolean);
  return bits.length ? `${f.name} (${bits.join(', ')})` : f.name;
};

type SetupProps = {
  connection: IntegrationConnection;
  onSaved: (connection: IntegrationConnection) => void;
  onCancel: () => void;
};

/**
 * A form provider's setup (Tally, Typeform): choose a form, check which
 * question fills which lead field, save. Both adapters expose the same
 * resources ('forms', 'questions') and settings ({ formId, fieldMap }).
 * Every choice is re-validated by the server against the provider before it is stored.
 */
const FormSetup: React.FC<SetupProps & { providerName: string }> = ({ connection, onSaved, onCancel, providerName }) => {
  const saved = connection.settings as { formId?: string; fieldMap?: Record<string, string> };
  const [forms, setForms] = useState<SetupResource[] | null>(null);
  const [questions, setQuestions] = useState<SetupResource[] | null>(null);
  const [formId, setFormId] = useState(saved.formId ?? '');
  const [fieldMap, setFieldMap] = useState<Record<string, string>>(saved.fieldMap ?? {});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadForms = useCallback(async () => {
    setError(null);
    setForms(null);
    try {
      setForms(await integrationsApi.resources(connection.id, 'forms'));
    } catch (e) {
      setError(messageFor(e));
      setForms([]);
    }
  }, [connection.id]);

  useEffect(() => {
    void loadForms();
  }, [loadForms]);

  useEffect(() => {
    if (!formId) {
      setQuestions(null);
      return;
    }
    let live = true;
    setQuestions(null);
    integrationsApi
      .resources(connection.id, 'questions', formId)
      .then((q) => {
        if (!live) return;
        setQuestions(q);
        // Keep the saved mapping for the saved form; another form starts from the server's suggestion.
        setFieldMap(formId === saved.formId && saved.fieldMap ? saved.fieldMap : suggestedMap(q));
      })
      .catch((e) => {
        if (!live) return;
        setError(messageFor(e));
        setQuestions([]);
      });
    return () => {
      live = false;
    };
    // saved.* is the stored setup and does not change while this panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, formId]);

  const taken = useMemo(() => new Map(Object.entries(fieldMap).map(([target, id]) => [id, target])), [fieldMap]);
  const canSave = Boolean(formId && questions && (fieldMap.email || fieldMap.phone)) && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await integrationsApi.updateSettings(connection.id, { formId, fieldMap });
      toast.success(updated.latestRun ? `Saved. Importing submissions from ${providerName} now.` : 'Saved.');
      onSaved(updated);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const label = 'block text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-1';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-4">
      <div className="flex items-center gap-2 text-xs font-bold text-white">
        <ClipboardList className="w-4 h-4 text-slate-400" /> Choose the form your leads fill in
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div>
        <label className={label} htmlFor={`form-${connection.id}`}>
          Form
        </label>
        <Select
          id={`form-${connection.id}`}
          value={formId}
          disabled={!forms || saving}
          onChange={(e) => {
            setFormId(e.target.value);
            setFieldMap({});
          }}
        >
          <option value="">{forms ? (forms.length ? 'Choose a form…' : `No forms in this ${providerName} account`) : 'Loading forms…'}</option>
          {forms?.map((f) => (
            <option key={f.id} value={f.id}>
              {formLabel(f)}
            </option>
          ))}
        </Select>
      </div>

      {formId && !questions && <div className="text-2xs text-slate-500">Loading questions…</div>}

      {questions && questions.length === 0 && formId && !error && <Notice tone="warning">This form has no questions to import yet.</Notice>}

      {questions && questions.length > 0 && (
        <div className="space-y-2">
          <div className="text-2xs text-slate-500">
            We matched these questions automatically. Change any that are wrong; answers to unmapped questions are kept on the lead as custom fields. Only completed
            submissions are imported.
          </div>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {LEAD_FIELDS.map((f) => {
              const options = questions.filter((q) => questionDetail(q).targets.includes(f.key));
              return (
                <div key={f.key}>
                  <label className={label} htmlFor={`map-${connection.id}-${f.key}`} title={f.hint}>
                    {f.label}
                    {(f.key === 'email' || f.key === 'phone') && <span className="normal-case tracking-normal text-slate-600"> · email or phone required</span>}
                  </label>
                  <Select
                    id={`map-${connection.id}-${f.key}`}
                    value={fieldMap[f.key] ?? ''}
                    disabled={saving}
                    onChange={(e) =>
                      setFieldMap((m) => {
                        const next = { ...m };
                        if (e.target.value) next[f.key] = e.target.value;
                        else delete next[f.key];
                        return next;
                      })
                    }
                  >
                    <option value="">— Not mapped —</option>
                    {options.map((q) => {
                      const other = taken.get(q.id);
                      return (
                        <option key={q.id} value={q.id} disabled={Boolean(other && other !== f.key)}>
                          {q.name}
                          {other && other !== f.key ? ' (already mapped)' : ''}
                        </option>
                      );
                    })}
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" icon={<Save />} onClick={() => void save()} disabled={!canSave} loading={saving}>
          Save and import
        </Button>
      </div>
    </div>
  );
};

export const TallySetup: React.FC<SetupProps> = (props) => <FormSetup {...props} providerName="Tally" />;
export const TypeformSetup: React.FC<SetupProps> = (props) => <FormSetup {...props} providerName="Typeform" />;
