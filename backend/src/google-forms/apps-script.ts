/**
 * The Google Apps Script an owner pastes into their form.
 *
 * It is generated per source because it carries that source's webhook URL and
 * signing secret — the same two things an owner pastes into Tally or Typeform,
 * just in a script because Google Forms has no webhook field of its own.
 *
 * Three things in here are load-bearing and easy to get wrong:
 *
 *   1. `e.response`, not `e.namedValues`. A FORM-bound trigger (what this is)
 *      gets a FormResponse. `e.namedValues` exists only on a SPREADSHEET-bound
 *      trigger, and reading it here would hand us `undefined` on every
 *      submission — a form that silently delivers nothing.
 *   2. An INSTALLABLE trigger, created by `estatePulseSetup`. The simple
 *      `onFormSubmit(e)` trigger runs without authorization and cannot call
 *      UrlFetchApp at all, so running the setup function (and granting its
 *      permissions once) is not optional.
 *   3. `fieldKey_` mirrors `fieldKey()` in forms-schema.ts byte for byte. The
 *      owner's mapping rows are keyed by what it returns, so if the two ever
 *      disagree every answer lands in custom fields instead of on the lead.
 *
 * Retries: Apps Script does not retry a failed UrlFetchApp call, so the script
 * keeps its own bounded queue. What it stores is the response ID and an
 * attempt count — never the payload, which would fill the 500 KB Properties
 * quota within a few hundred submissions. The retry re-reads the response from
 * the form by ID instead. Past MAX_ATTEMPTS it gives up and lets the backend's
 * recovery poller find the response.
 */

export interface AppsScriptInput {
  /** The full ingest URL: ${PUBLIC_API_URL}/ingest/v1/google-forms/:token. */
  webhookUrl: string;
  /** The source's signing secret. The owner's own credential, for their own form. */
  signingSecret: string;
  /** Google's form id, so a script pasted into the wrong form says so. */
  formId: string;
  /** lead_sources.id — the stable source identifier carried on every payload. */
  sourceId: string;
  /** For the header comment only. */
  formName: string;
}

/** Keeps a generated value from closing the script's own string literal. */
const js = (value: string): string => JSON.stringify(String(value ?? ''));

export function generateAppsScript(input: AppsScriptInput): string {
  return `/**
 * EstatePulse — sends ${input.formName.replace(/\*\//g, '* /')} responses to your CRM.
 *
 * Setup, once:
 *   1. Run "estatePulseSetup" from the Run menu above.
 *   2. Google shows a red "Google hasn't verified this app" screen. That is
 *      expected: this script is your own, in your own account, and the warning
 *      is about you. Click "Advanced", then "Go to ... (unsafe)", then "Allow".
 *      The "Allow" button is hidden until you click "Advanced".
 *   3. Submit a test response in your form to check it arrives.
 *
 * Keep this file private: the key below is what proves a response came from
 * your form. Anyone with it could post leads into your account.
 */

var ESTATEPULSE_URL = ${js(input.webhookUrl)};
var ESTATEPULSE_KEY = ${js(input.signingSecret)};
var ESTATEPULSE_FORM_ID = ${js(input.formId)};
var ESTATEPULSE_SOURCE_ID = ${js(input.sourceId)};

/** Give up after this many tries; EstatePulse's own recovery then picks it up. */
var MAX_ATTEMPTS = 6;
/** Never let a forgotten failure fill the script's property store. */
var MAX_QUEUED = 50;
/** How often the retry trigger runs. Apps Script allows 1, 5, 10, 15 or 30. */
var RETRY_EVERY_MINUTES = 10;
/** Stop a retry run well inside Apps Script's 6-minute execution limit. */
var MAX_RUN_MS = 240000;
var RETRY_PREFIX = 'ep_retry_';

/** Items that hold no answer, so they are not questions and get no key. */
var NOT_A_QUESTION = ['IMAGE', 'PAGE_BREAK', 'SECTION_HEADER', 'VIDEO'];

/* ------------------------------------------------------------------ setup */

/**
 * Run this once. It installs the submit trigger (which is what actually sends
 * responses) and the retry trigger, replacing any left by an earlier copy of
 * this script so running it twice is harmless.
 */
function estatePulseSetup() {
  var form = FormApp.getActiveForm();
  if (!form) {
    throw new Error('Open this script from your Google Form (Extensions > Apps Script), not as a standalone project.');
  }
  if (form.getId() !== ESTATEPULSE_FORM_ID) {
    throw new Error('This script was generated for a different form. Copy the script for THIS form from EstatePulse.');
  }

  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    var handler = existing[i].getHandlerFunction();
    if (handler === 'estatePulseOnSubmit' || handler === 'estatePulseRetry') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('estatePulseOnSubmit').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('estatePulseRetry').timeBased().everyMinutes(RETRY_EVERY_MINUTES).create();

  Logger.log('EstatePulse: set up. New responses will be sent automatically.');
}

/* ----------------------------------------------------------- the delivery */

/** Runs on every submission. Installed by estatePulseSetup — do not rename. */
function estatePulseOnSubmit(e) {
  // A form-bound installable trigger hands us the FormResponse here. If it is
  // missing, the trigger was created the wrong way; say so rather than fail
  // silently on every submission from now on.
  if (!e || !e.response) {
    Logger.log('EstatePulse: no response on the event — run estatePulseSetup again.');
    return;
  }
  var responseId = e.response.getId();
  var result = estatePulseSend_(buildPayload_(FormApp.getActiveForm(), e.response));
  if (result.ok) {
    estatePulseForget_(responseId);
    return;
  }
  if (result.permanent) {
    Logger.log('EstatePulse: response ' + responseId + ' refused (HTTP ' + result.status + '), not retrying.');
    return;
  }
  estatePulseQueue_(responseId, 0);
  Logger.log('EstatePulse: response ' + responseId + ' not delivered (HTTP ' + result.status + '), queued for retry.');
}

/**
 * Retries what the submit handler could not deliver, oldest first.
 *
 * Takes the script lock so two overlapping runs never send the same response
 * twice, re-reads each response from the form by ID (rather than keeping a
 * copy), and backs off exponentially. EstatePulse ignores a duplicate anyway —
 * the response ID is its idempotency key — but sending one is still wasted work.
 */
function estatePulseRetry() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var started = new Date().getTime();
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var form = FormApp.getActiveForm();

    for (var key in all) {
      if (key.indexOf(RETRY_PREFIX) !== 0) continue;
      if (new Date().getTime() - started > MAX_RUN_MS) return;

      var responseId = key.substring(RETRY_PREFIX.length);
      var state = estatePulseParse_(all[key]);
      if (!state || state.n > new Date().getTime()) continue;

      if (state.a >= MAX_ATTEMPTS) {
        props.deleteProperty(key);
        Logger.log('EstatePulse: giving up on response ' + responseId + ' after ' + state.a + ' tries. EstatePulse will recover it.');
        continue;
      }

      var response = null;
      try {
        response = form.getResponse(responseId);
      } catch (err) {
        // Deleted from the form, so there is nothing left to send.
        props.deleteProperty(key);
        Logger.log('EstatePulse: response ' + responseId + ' is no longer on the form; dropped.');
        continue;
      }

      var result = estatePulseSend_(buildPayload_(form, response));
      if (result.ok || result.permanent) {
        props.deleteProperty(key);
        if (!result.ok) Logger.log('EstatePulse: response ' + responseId + ' refused (HTTP ' + result.status + '), dropped.');
      } else {
        estatePulseQueue_(responseId, state.a + 1);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** POSTs one payload. Returns whether it landed, and whether retrying is worth it. */
function estatePulseSend_(payload) {
  var body = JSON.stringify(payload);
  var signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(body, ESTATEPULSE_KEY));
  var response;
  try {
    response = UrlFetchApp.fetch(ESTATEPULSE_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      headers: { 'X-EstatePulse-Signature': 'sha256=' + signature },
      muteHttpExceptions: true,
      followRedirects: false,
      validateHttpsCertificates: true
    });
  } catch (err) {
    // Could not reach EstatePulse at all. Worth retrying.
    return { ok: false, permanent: false, status: 0 };
  }

  var status = response.getResponseCode();
  if (status >= 200 && status < 300) return { ok: true, permanent: false, status: status };
  // 408 and 429 are "try later"; every other 4xx means this payload will never
  // be accepted, so retrying it only burns quota.
  var permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { ok: false, permanent: permanent, status: status };
}

/* ------------------------------------------------------------ the payload */

/**
 * Every question on the form, answered or not, in the order they appear.
 *
 * Unanswered questions are included with an empty value list on purpose: it is
 * what lets EstatePulse show the owner a question to map before anybody has
 * filled it in.
 */
function buildPayload_(form, response) {
  var answers = {};
  var itemResponses = response.getItemResponses();
  for (var i = 0; i < itemResponses.length; i++) {
    answers[itemResponses[i].getItem().getId()] = itemResponses[i].getResponse();
  }

  var seen = {};
  var questions = [];
  var items = form.getItems();
  for (var j = 0; j < items.length; j++) {
    var item = items[j];
    var type = String(item.getType());
    if (NOT_A_QUESTION.indexOf(type) !== -1) continue;

    var title = item.getTitle() || '';
    var ordinal = (seen[title] || 0) + 1;
    seen[title] = ordinal;

    questions.push({
      key: fieldKey_(title, ordinal),
      itemId: String(item.getId()),
      title: title,
      type: questionType_(type),
      values: flatten_(answers[item.getId()])
    });
  }

  return {
    source: 'google_forms',
    version: 1,
    sourceId: ESTATEPULSE_SOURCE_ID,
    formId: form.getId(),
    formTitle: form.getTitle(),
    responseId: response.getId(),
    submittedAt: response.getTimestamp().toISOString(),
    questions: questions
  };
}

/**
 * MIRRORS fieldKey() in EstatePulse's forms-schema.ts. If you change one,
 * change the other, or saved mappings stop matching their questions.
 */
function fieldKey_(title, ordinal) {
  var slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 120);
  var base = slug ? 'q_' + slug : 'q_untitled';
  return ordinal > 1 ? base + '__' + ordinal : base;
}

/** Apps Script's item types in EstatePulse's vocabulary (see forms-schema.ts). */
function questionType_(type) {
  switch (type) {
    case 'PARAGRAPH_TEXT': return 'PARAGRAPH_TEXT';
    case 'MULTIPLE_CHOICE': return 'MULTIPLE_CHOICE';
    case 'CHECKBOX': return 'CHECKBOXES';
    case 'LIST': return 'DROPDOWN';
    case 'SCALE': return 'SCALE';
    case 'DATE':
    case 'DATETIME': return 'DATE';
    case 'TIME':
    case 'DURATION': return 'TIME';
    case 'FILE_UPLOAD': return 'FILE_UPLOAD';
    case 'GRID':
    case 'CHECKBOX_GRID': return 'GRID';
    default: return 'TEXT';
  }
}

/**
 * One answer as a list of plain strings.
 *
 * getResponse() gives a string for most questions, a list for a checkbox or a
 * grid, and a list of lists for a checkbox grid. A file upload gives Drive
 * file IDs, which are passed through as-is: EstatePulse records that files
 * were attached and never tries to open them.
 */
function flatten_(value) {
  if (value === null || value === undefined || value === '') return [];
  if (!Array.isArray(value)) return [String(value)];
  var out = [];
  for (var i = 0; i < value.length; i++) {
    var v = value[i];
    if (Array.isArray(v)) {
      for (var k = 0; k < v.length; k++) {
        if (v[k] !== null && v[k] !== undefined && v[k] !== '') out.push(String(v[k]));
      }
    } else if (v !== null && v !== undefined && v !== '') {
      out.push(String(v));
    }
  }
  return out;
}

/* ------------------------------------------------------------ retry state */

/**
 * Remembers that one response still has to go, and when to try it next.
 *
 * Stores an attempt count and a timestamp — about fifty bytes — and never the
 * response itself, so the property store cannot be filled by a bad afternoon.
 * Past MAX_QUEUED the oldest entries are kept and this one is dropped;
 * EstatePulse's recovery poller is the backstop for anything dropped here.
 */
function estatePulseQueue_(responseId, attempts) {
  var props = PropertiesService.getScriptProperties();
  var key = RETRY_PREFIX + responseId;
  if (!props.getProperty(key) && estatePulseQueueSize_(props) >= MAX_QUEUED) {
    Logger.log('EstatePulse: retry queue is full; response ' + responseId + ' left for EstatePulse to recover.');
    return;
  }
  // 5, 10, 20, 40, 80, 160 minutes.
  var waitMs = Math.min(Math.pow(2, attempts) * 5, 160) * 60 * 1000;
  props.setProperty(key, JSON.stringify({ a: attempts, n: new Date().getTime() + waitMs }));
}

function estatePulseForget_(responseId) {
  PropertiesService.getScriptProperties().deleteProperty(RETRY_PREFIX + responseId);
}

function estatePulseQueueSize_(props) {
  var all = props.getProperties();
  var n = 0;
  for (var key in all) if (key.indexOf(RETRY_PREFIX) === 0) n++;
  return n;
}

function estatePulseParse_(raw) {
  try {
    var parsed = JSON.parse(raw);
    return { a: Number(parsed.a) || 0, n: Number(parsed.n) || 0 };
  } catch (err) {
    return null;
  }
}
`;
}
