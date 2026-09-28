import React, { useMemo, useState } from 'react';
import { Beaker, Plus, Trash2, X } from 'lucide-react';
import {
  blankTool,
  testTool,
  LEAD_VARIABLES,
  TOOL_TYPE_INFO,
  type AssistantTool,
  type ToolParamSchema,
  type ToolTestResult,
  type ToolType,
} from '../../utils/assistantApi';

/**
 * Build one tool for the AI agent.
 *
 * This is the screen that used to be a link to the provider's console. The
 * shapes below are the provider's own tool schemas rendered as a form, so what
 * is typed here is what is sent — there is no intermediate representation to
 * drift out of step with the API.
 *
 * A webhook tool's parameters are a real JSON Schema, and the model reads the
 * DESCRIPTION of each one to decide what to put in it. That is why every
 * parameter row has a description field next to its name and why the placeholder
 * text is a sentence rather than a type: a parameter called `budget` described
 * as "the buyer's maximum budget in dollars" gets filled correctly, and the same
 * parameter with an empty description mostly does not.
 */

interface Props {
  /** Null builds a new tool; a tool edits that one. */
  tool: AssistantTool | null;
  onClose: () => void;
  onSave: (tool: AssistantTool) => Promise<void>;
}

const label = 'block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1';
const input =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-600';

/** The JSON-Schema property bag, flattened into rows a form can edit. */
interface ParamRow {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

const toRows = (schema?: ToolParamSchema): ParamRow[] =>
  Object.entries(schema?.properties ?? {}).map(([name, def]) => ({
    name,
    type: def.type ?? 'string',
    description: def.description ?? '',
    required: (schema?.required ?? []).includes(name),
  }));

const toSchema = (rows: ParamRow[]): ToolParamSchema | undefined => {
  const named = rows.filter((r) => r.name.trim());
  if (named.length === 0) return undefined;
  return {
    type: 'object',
    properties: Object.fromEntries(
      named.map((r) => [r.name.trim(), { type: r.type, description: r.description }]),
    ),
    required: named.filter((r) => r.required).map((r) => r.name.trim()),
  };
};

export const ToolEditorModal: React.FC<Props> = ({ tool, onClose, onSave }) => {
  const isNew = tool === null;
  const [type, setType] = useState<ToolType>((tool?.type as ToolType) ?? 'webhook');

  // Seeded once from the tool being edited. Switching type below swaps the
  // draft wholesale rather than trying to carry fields across, because a
  // transfer target is not a webhook url under another name.
  const [draft, setDraft] = useState<AssistantTool>(tool ?? blankTool('webhook'));
  const [params, setParams] = useState<ParamRow[]>(
    toRows(tool?.webhook?.body_parameters ?? tool?.webhook?.query_parameters),
  );
  const [headers, setHeaders] = useState(tool?.webhook?.headers ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test panel — only reachable for a webhook tool that has been saved once,
  // since the provider tests it by id and an unsaved tool does not have one.
  const [testArgs, setTestArgs] = useState('{}');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ToolTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const w = draft.webhook;
  const canTest = type === 'webhook' && !!tool?.id;

  const changeType = (next: ToolType) => {
    setType(next);
    setDraft(blankTool(next));
    setParams([]);
    setHeaders([]);
  };

  const setWebhook = (patch: Partial<NonNullable<AssistantTool['webhook']>>) =>
    setDraft((d) => ({ ...d, webhook: { ...d.webhook!, ...patch } }));

  /** The draft as the API wants it — the form rows folded back into schemas. */
  const built = useMemo((): AssistantTool => {
    if (type !== 'webhook') return draft;
    const schema = toSchema(params);
    const useQuery = (w?.method ?? 'POST') === 'GET';
    return {
      ...draft,
      webhook: {
        ...w!,
        headers: headers.filter((h) => h.name.trim()),
        // GET has no body, so the same rows become query parameters instead.
        // Both keys are cleared first so switching method cannot leave the
        // parameters attached to the wrong one.
        body_parameters: useQuery ? undefined : schema,
        query_parameters: useQuery ? schema : undefined,
      },
    };
  }, [draft, type, params, headers, w]);

  const validate = (): string | null => {
    if (type === 'webhook') {
      if (!w?.name?.trim()) return 'Give the tool a name — the agent uses it to decide when to call it.';
      if (!/^[a-zA-Z0-9_-]+$/.test(w.name.trim())) return 'The name may only contain letters, numbers, hyphens and underscores.';
      if (!w?.description?.trim()) return 'Describe what the tool does. The agent reads this to decide when to use it.';
      if (!w?.url?.trim()) return 'A webhook tool needs a URL to call.';
    }
    if (type === 'transfer') {
      const targets = draft.transfer?.targets ?? [];
      if (targets.length === 0 || !targets.some((t) => t.to.trim())) {
        return 'Add at least one number to transfer to.';
      }
    }
    return null;
  };

  const save = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(built);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not save the tool.');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(testArgs || '{}');
      } catch {
        throw new Error('The test arguments are not valid JSON.');
      }
      // Example values, so a {{firstName}} in the url or body resolves to
      // something readable rather than to an empty string.
      const vars = Object.fromEntries(LEAD_VARIABLES.map((v) => [v.name, v.example]));
      setTestResult(await testTool(tool!.id!, args, vars));
    } catch (e: any) {
      setTestError(e?.message || 'The test could not be run.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto p-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h3 className="text-base font-bold text-white">
              {isNew ? 'Add a tool' : 'Edit tool'}
            </h3>
            <p className="text-[11px] text-slate-400">
              Something the agent can do during a call, beyond talking.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 cursor-pointer" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {error && (
            <div className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Type. Locked when editing: changing it would discard every field. */}
          <div>
            <label className={label}>What should it do?</label>
            {isNew ? (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {(Object.keys(TOOL_TYPE_INFO) as ToolType[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => changeType(t)}
                    className={`px-3 py-2 rounded-xl border text-xs font-semibold cursor-pointer transition ${
                      type === t
                        ? 'bg-emerald-600/20 border-emerald-600 text-emerald-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    {TOOL_TYPE_INFO[t].label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-300 font-semibold">{TOOL_TYPE_INFO[type]?.label ?? type}</div>
            )}
            <p className="text-[11px] text-slate-500 mt-1.5">{TOOL_TYPE_INFO[type]?.blurb}</p>
          </div>

          {type === 'webhook' && w && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={label}>Tool name</label>
                  <input
                    className={input}
                    value={w.name}
                    onChange={(e) => setWebhook({ name: e.target.value })}
                    placeholder="report_qualification"
                  />
                </div>
                <div>
                  <label className={label}>Timeout (ms)</label>
                  <input
                    type="number"
                    className={input}
                    value={w.timeout_ms ?? 5000}
                    onChange={(e) => setWebhook({ timeout_ms: Number(e.target.value) })}
                  />
                </div>
              </div>

              <div>
                <label className={label}>When should the agent use it?</label>
                <textarea
                  className={`${input} h-16 resize-none`}
                  value={w.description}
                  onChange={(e) => setWebhook({ description: e.target.value })}
                  placeholder="Call this once the buyer's timeline, budget and location are known, to record how qualified they are."
                />
              </div>

              <div className="grid grid-cols-[100px_1fr] gap-3">
                <div>
                  <label className={label}>Method</label>
                  <select
                    className={input}
                    value={w.method ?? 'POST'}
                    onChange={(e) => setWebhook({ method: e.target.value as any })}
                  >
                    {['GET', 'POST', 'PUT', 'DELETE'].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>URL</label>
                  <input
                    className={`${input} font-mono`}
                    value={w.url}
                    onChange={(e) => setWebhook({ url: e.target.value })}
                    placeholder="https://your-portal.com/api/leads/{{leadId}}/qualified"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500 -mt-2">
                <span className="text-slate-400">{'{{leadId}}'}</span> and the other lead variables can be used
                anywhere in the URL, headers or parameters.
              </p>

              {/* Headers */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={label}>Headers</label>
                  <button
                    onClick={() => setHeaders([...headers, { name: '', value: '' }])}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" /> Add header
                  </button>
                </div>
                {headers.length === 0 && <p className="text-[11px] text-slate-600">None.</p>}
                <div className="space-y-2">
                  {headers.map((h, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        className={`${input} font-mono`}
                        value={h.name}
                        onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        placeholder="X-Api-Key"
                      />
                      <input
                        className={`${input} font-mono`}
                        value={h.value}
                        onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        placeholder="value"
                      />
                      <button
                        onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                        className="text-slate-500 hover:text-rose-400 cursor-pointer shrink-0"
                        aria-label="Remove header"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Parameters the model fills in */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={label}>
                    {(w.method ?? 'POST') === 'GET' ? 'Query parameters' : 'Body parameters'}
                  </label>
                  <button
                    onClick={() => setParams([...params, { name: '', type: 'string', description: '', required: false }])}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" /> Add parameter
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mb-2">
                  The agent decides what to put in each of these, reading the description. Be specific.
                </p>
                <div className="space-y-2">
                  {params.map((p, i) => (
                    <div key={i} className="grid grid-cols-[1fr_90px_1.6fr_auto_auto] gap-2 items-center">
                      <input
                        className={`${input} font-mono`}
                        value={p.name}
                        onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        placeholder="temperature"
                      />
                      <select
                        className={input}
                        value={p.type}
                        onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                      >
                        {['string', 'number', 'boolean', 'object', 'array'].map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                      <input
                        className={input}
                        value={p.description}
                        onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                        placeholder="hot, warm or cold — how ready the buyer is"
                      />
                      <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={p.required}
                          onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                        />
                        req
                      </label>
                      <button
                        onClick={() => setParams(params.filter((_, j) => j !== i))}
                        className="text-slate-500 hover:text-rose-400 cursor-pointer"
                        aria-label="Remove parameter"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {params.length === 0 && <p className="text-[11px] text-slate-600">None.</p>}
                </div>
              </div>
            </>
          )}

          {type === 'transfer' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={label}>Transfer to</label>
                <button
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      transfer: { ...d.transfer!, targets: [...(d.transfer?.targets ?? []), { name: '', to: '' }] },
                    }))
                  }
                  className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Add destination
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mb-2">
                The agent picks by name, so name them the way you would say it out loud — "the listing agent",
                "the front desk".
              </p>
              <div className="space-y-2">
                {(draft.transfer?.targets ?? []).map((t, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input
                      className={input}
                      value={t.name}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          transfer: {
                            ...d.transfer!,
                            targets: d.transfer!.targets.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          },
                        }))
                      }
                      placeholder="Senior buying agent"
                    />
                    <input
                      className={`${input} font-mono`}
                      value={t.to}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          transfer: {
                            ...d.transfer!,
                            targets: d.transfer!.targets.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                          },
                        }))
                      }
                      placeholder="+15125550147"
                    />
                    <button
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          transfer: { ...d.transfer!, targets: d.transfer!.targets.filter((_, j) => j !== i) },
                        }))
                      }
                      className="text-slate-500 hover:text-rose-400 cursor-pointer shrink-0"
                      aria-label="Remove destination"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {type === 'hangup' && (
            <div>
              <label className={label}>When may the agent end the call?</label>
              <textarea
                className={`${input} h-16 resize-none`}
                value={draft.hangup?.description ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, hangup: { description: e.target.value } }))}
                placeholder="Once the buyer has said goodbye, or has clearly said they are not interested."
              />
            </div>
          )}

          {type === 'handoff' && (
            <div>
              <label className={label}>Agent IDs to hand off to</label>
              <input
                className={`${input} font-mono`}
                value={(draft.handoff?.ai_assistants ?? []).join(', ')}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    handoff: {
                      ...d.handoff,
                      ai_assistants: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    },
                  }))
                }
                placeholder="assistant-abc123, assistant-def456"
              />
              <label className={`${label} mt-3`}>Voice</label>
              <select
                className={input}
                value={draft.handoff?.voice_mode ?? 'same'}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, handoff: { ...d.handoff, voice_mode: e.target.value as any } }))
                }
              >
                <option value="same">Keep the same voice</option>
                <option value="distinct">Use each agent's own voice</option>
              </select>
            </div>
          )}

          {type === 'send_dtmf' && (
            <p className="text-xs text-slate-400">
              Nothing to configure. The agent will be able to press phone keys when a menu asks it to.
            </p>
          )}

          {/* Live test. The only way to find a bad URL without spending a call. */}
          {canTest && (
            <div className="border-t border-slate-800 pt-5">
              <h4 className="text-xs font-bold text-white flex items-center gap-2 mb-2">
                <Beaker className="w-3.5 h-3.5 text-amber-400" /> Test it
              </h4>
              <p className="text-[11px] text-slate-500 mb-2">
                Calls the webhook for real, with these arguments in place of the ones the agent would choose.
                Lead variables are filled with example values.
              </p>
              <textarea
                className={`${input} h-20 font-mono resize-none`}
                value={testArgs}
                onChange={(e) => setTestArgs(e.target.value)}
                placeholder='{ "temperature": "hot" }'
              />
              <button
                onClick={runTest}
                disabled={testing}
                className="mt-2 px-3 py-1.5 bg-amber-600/20 border border-amber-600/40 text-amber-300 rounded-lg text-xs font-semibold hover:bg-amber-600/30 disabled:opacity-50 cursor-pointer"
              >
                {testing ? 'Calling…' : 'Send test request'}
              </button>

              {testError && (
                <div className="mt-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-800/40 rounded-lg px-3 py-2">
                  {testError}
                </div>
              )}
              {testResult && (
                <div
                  className={`mt-2 rounded-lg px-3 py-2 text-[11px] border ${
                    testResult.success
                      ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-200'
                      : 'bg-rose-950/30 border-rose-800/40 text-rose-200'
                  }`}
                >
                  <div className="font-semibold mb-1">
                    {testResult.success ? 'Succeeded' : 'Failed'}
                    {testResult.status_code != null && ` — HTTP ${testResult.status_code}`}
                  </div>
                  {testResult.response && (
                    <pre className="font-mono whitespace-pre-wrap break-all text-slate-300 max-h-40 overflow-y-auto">
                      {testResult.response}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
          {type === 'webhook' && !canTest && (
            <p className="text-[11px] text-slate-600 border-t border-slate-800 pt-4">
              Save the tool to be able to send it a test request.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold disabled:opacity-50 cursor-pointer"
          >
            {saving ? 'Saving…' : isNew ? 'Add tool' : 'Save tool'}
          </button>
        </div>
      </div>
    </div>
  );
};
