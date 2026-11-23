import { describe, expect, it } from 'vitest';
import { generateAppsScript } from './apps-script';
import { fieldKey } from './forms-schema';

const script = generateAppsScript({
  webhookUrl: 'https://api.example.test/ingest/v1/google-forms/whk_live_ABCDEFGHJKMNPQRSTVWX',
  signingSecret: 'whsec_test_secret_value',
  formId: '1FAIpQLSdExampleFormId',
  sourceId: '0c6f0a9e-2a1b-4e4b-9c2f-0a1b2c3d4e5f',
  formName: 'Buyer enquiry',
});

/** Pulls one function out of the generated script so it can actually be run. */
function extract(name: string): (...args: never[]) => unknown {
  const start = script.indexOf(`function ${name}(`);
  expect(start, `${name} is missing from the generated script`).toBeGreaterThan(-1);
  let depth = 0;
  let i = script.indexOf('{', start);
  const from = i;
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) break;
  }
  const body = script.slice(from + 1, i);
  const args = script.slice(script.indexOf('(', start) + 1, script.indexOf(')', start));
  return new Function(...args.split(',').map((a) => a.trim()).filter(Boolean), body) as (...args: never[]) => unknown;
}

describe('the generated script and the backend agree on question keys', () => {
  // The single most important thing in this file. The owner's mapping rows are
  // keyed by what fieldKey() returns; if the script's copy ever drifts from
  // it, every answer quietly lands in custom fields instead of on the lead and
  // nothing visibly breaks until someone wonders why no leads have names.
  const scriptKey = extract('fieldKey_') as (title: string, ordinal: number) => string;

  const titles = [
    'Full name',
    'Email',
    'Phone number',
    'What’s your budget?',
    '  Spaces   everywhere  ',
    'Mixed CASE and 123',
    'Punctuation!@#$%^&*()',
    '🏠',
    '',
    'a'.repeat(200),
    'Áccented tïtle',
  ];

  it.each(titles)('matches for %j', (title) => {
    expect(scriptKey(title, 1)).toBe(fieldKey(title, 1));
    expect(scriptKey(title, 2)).toBe(fieldKey(title, 2));
    expect(scriptKey(title, 7)).toBe(fieldKey(title, 7));
  });
});

describe('the generated script’s answer flattening', () => {
  const flatten = extract('flatten_') as (value: unknown) => string[];

  it('reads a plain text answer', () => {
    expect(flatten('Manish')).toEqual(['Manish']);
  });

  it('reads every tick of a checkbox answer', () => {
    expect(flatten(['Bandra', 'Juhu'])).toEqual(['Bandra', 'Juhu']);
  });

  it('flattens a checkbox grid, which answers as a list of lists', () => {
    expect(flatten([['a', 'b'], ['c']])).toEqual(['a', 'b', 'c']);
  });

  it('treats an unanswered question as no values at all', () => {
    expect(flatten(null)).toEqual([]);
    expect(flatten(undefined)).toEqual([]);
    expect(flatten('')).toEqual([]);
    // A grid row nobody filled in arrives as a null inside the list.
    expect(flatten(['a', null, ''])).toEqual(['a']);
  });
});

describe('the generated script’s Apps Script contract', () => {
  it('reads e.response, never the spreadsheet-only e.namedValues', () => {
    expect(script).toContain('e.response');
    // namedValues is undefined on a form-bound trigger: using it would mean a
    // form that silently delivers nothing on every submission.
    expect(script).not.toContain('namedValues');
  });

  it('creates an installable form-submit trigger, which is what may call UrlFetchApp', () => {
    expect(script).toContain("ScriptApp.newTrigger('estatePulseOnSubmit').forForm(form).onFormSubmit().create()");
  });

  it('refuses to run against a form it was not generated for', () => {
    expect(script).toContain('form.getId() !== ESTATEPULSE_FORM_ID');
  });

  it('signs every body the way the ingest route verifies it', () => {
    expect(script).toContain('Utilities.computeHmacSha256Signature(body, ESTATEPULSE_KEY)');
    expect(script).toContain("'X-EstatePulse-Signature': 'sha256=' + signature");
  });

  it('carries the source identifier and the response id on every payload', () => {
    expect(script).toContain('sourceId: ESTATEPULSE_SOURCE_ID');
    expect(script).toContain('responseId: response.getId()');
    expect(script).toContain('submittedAt: response.getTimestamp().toISOString()');
  });

  it('puts the generated URL and key in, escaped so neither can break the script', () => {
    expect(script).toContain('var ESTATEPULSE_URL = "https://api.example.test/ingest/v1/google-forms/whk_live_ABCDEFGHJKMNPQRSTVWX";');
    expect(script).toContain('var ESTATEPULSE_KEY = "whsec_test_secret_value";');
  });

  it('cannot be broken out of by a hostile form name', () => {
    const nasty = generateAppsScript({
      webhookUrl: 'https://x.test/a',
      signingSecret: '";var pwned=1;//',
      formId: 'f',
      sourceId: 's',
      formName: 'Buyer */ enquiry',
    });
    expect(nasty).toContain('var ESTATEPULSE_KEY = "\\";var pwned=1;//";');
    // The comment header cannot be closed early either.
    expect(nasty).not.toContain('Buyer */ enquiry');
  });
});

describe('the generated script’s bounded retry', () => {
  it('backs off exponentially and gives up, leaving the rest to EstatePulse', () => {
    expect(script).toContain('var MAX_ATTEMPTS = 6;');
    expect(script).toContain('Math.min(Math.pow(2, attempts) * 5, 160) * 60 * 1000');
    expect(script).toContain('giving up on response');
  });

  it('locks, so two runs never send the same response twice', () => {
    expect(script).toContain('LockService.getScriptLock()');
    expect(script).toContain('lock.releaseLock()');
  });

  it('stops well inside the execution limit', () => {
    expect(script).toContain('var MAX_RUN_MS = 240000;');
    expect(script).toContain('started > MAX_RUN_MS');
  });

  it('stores an attempt count, never the payload, and caps how many it keeps', () => {
    expect(script).toContain('var MAX_QUEUED = 50;');
    expect(script).toContain('JSON.stringify({ a: attempts, n:');
    // The retry re-reads the response from the form instead of keeping a copy,
    // which is what keeps the 500 KB Properties quota out of reach.
    expect(script).toContain('form.getResponse(responseId)');
  });

  it('does not retry a payload the server has refused outright', () => {
    expect(script).toContain('status !== 408 && status !== 429');
  });

  it('logs the response id and status, never an answer', () => {
    expect(script).toContain("Logger.log('EstatePulse: response ' + responseId + ' not delivered (HTTP '");
    expect(script).not.toMatch(/Logger\.log\([^)]*payload/);
    expect(script).not.toMatch(/Logger\.log\([^)]*ESTATEPULSE_KEY/);
  });
});
