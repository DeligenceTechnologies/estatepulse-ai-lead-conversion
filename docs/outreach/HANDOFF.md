# Conditional outreach: handoff

Branch `feature/conditional-outreach`, as of 2026-10-27.

The branch is built on `origin/master` 3180897, which includes the "AI opening wait" from `feature/human-takeover`. The branch has its own commit with all of this work. It is **not pushed**. Nothing else on the branch is unfinished.

This file is enough to carry on without the chat that produced the work. File and line references are to this commit.

---

## 1. Status at a glance

| | |
|---|---|
| What exists | Two-step outreach strategy (one AI call + one SMS, swappable), a "start after" delay on step 1, and a step-2 condition (plain dropdown). |
| | Built-in safety rules that every strategy step and sequence step passes. |
| | A record of every step run (sent / queued / failed / skipped, with why), shown on the lead. |
| | Fixes from the "Outreach Journey Redesign" audit: B1, B4, B5, B8, B10, B11, C2, D1, D2, A4, D4. |
| | Lead quick actions: Pause/Resume automation and Mark as booked. |
| Migrations | `20261026000001_outreach_step_runs` and `20261026000002_call_end_reason_amd`. Both are additive and both are applied to the dev DB `estate_manish`. |
| Feature flag | None. It runs with the existing `STRATEGY_ENGINE` flag, like the engine always did. |
| Tests at commit | Backend: tsc clean, unit 258/258. Integration: `conditional-outreach.int.ts` 30/30, `outreach-schedule.int.ts` 21/21 (last recorded run). |
| | Frontend: unit 125/130, build ok. The 5 failures and the 2 tsc errors are all in locally-excluded stray specs (see §9). |
| UI verification | Not done in a browser. The screens were only checked by tests and by the owner's own screenshots. |

---

## 2. How to resume

```bash
# backend
cd backend
npx prisma migrate deploy      # applies the two migrations on a fresh DB
npx prisma generate            # STOP the dev server first: it locks the Prisma engine DLL (EPERM on Windows)
npx tsc --noEmit -p tsconfig.json   # 91 errors live in src/modules/*.test.ts: untracked strays, ignore them
npx vitest run                                                                  # unit
npx vitest run -c vitest.integration.config.ts src/outreach/conditional-outreach.int.ts   # real DB
npm run test:outreach-schedule                                                  # real DB

# frontend
cd frontend
npx tsc --noEmit     # 2 errors, both in stray specs (LeadDetailModal.spec.tsx, LeadsView.spec.tsx)
npx vitest run       # 5 failures, all in the stray LeadsView.spec.tsx
npx vite build
```

**Environment gotchas**
- The owner's dev server often runs from this folder (`nest start --watch` on :4000, with `STRATEGY_ENGINE=1` and the call worker on). It picks up edits live, including anything that places real calls.
- The integration suites never boot Nest. They build services by hand: no lead watcher, no runner poll, no call worker. The SMS and call queue are stand-ins, and the follow-up runner only gets the suite's own enrolment through `execute()`.
- On Windows, bash heredocs mangle quotes and backslashes. Patch files with a node script and keep CRLF endings. `core.autocrlf=true` normalises them on commit.

---

## 3. Current behaviour

### 3.1 The strategy (new leads)

**Shape** (`backend/src/telnyx/strategy-store.service.ts`)
- Exactly `MAX_STRATEGY_STEPS = 2` steps (:8): one `voice` and one `sms`, in either order.
- Step 1 waits `after` from when the lead comes in. The limit is `0 ≤ after ≤ STEP1_MAX_DELAY_MS = 12h` (:11).
  - The cap exists because the lead watcher parks an in-strategy lead older than `STRATEGY_STALE_MS` (24h) as stalled.
- Step 2 waits `after` from the end of step 1:
  - Call → SMS: from when the call **ends**.
  - SMS → Call: from when the SMS is **sent**.
- Step 2 carries `onlyIf` (§3.3). Step 1 never has a condition.
- A strategy the editor saves carries `timing: 'after_previous'`.

**Validation**
- `validateTwoStep` (:120) checks: two steps of different channels; step 1 delay ≤ 12h; no condition on step 1; step 2's `onlyIf` passes `onlyIfError` for its context; an SMS step has a message.
- `saveStrategy` (:150) saves through `asEditable` (:85). Step 2 gets `onlyIf` (an older `condition` is mapped), and `condition` is dropped.
- A save of only `guardrails`/`name` leaves the steps and `timing` untouched. ContactWindowCard relies on this.

**Older strategies** (no `timing`, any number of steps, waits counted from enrolment)
- They are never rewritten and run as they always did.
- `toTwoStep` (:97) is only the editor's view of them: the first call and the first SMS, in the order they really ran, with step 2 waiting the real gap (never negative).
- `converted: true` means the editor is showing a form that has not been saved yet.

**Default for an org that never saved one** (`defaultStrategy`, :48): Call at 0, then SMS 5 min after the call ends, "Only if the call was not answered". The text is "Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?".

**API** (`backend/src/telnyx/portal.controller.ts:146`): `GET`/`PUT /strategy` return `{ strategy, editor: toTwoStep(strategy), safetyRules: SAFETY_RULES }`.

### 3.2 The engine (`backend/src/telnyx/engine.service.ts`)

**Scheduling**
- Steps run strictly in order: one timer, then the next step is scheduled (`planOf` :59, `scheduleNext` :335).
- Older strategies are timed from enrolment plus the quiet-hours shift. Two-step strategies are timed from `lastRanAt`.

**`fireStep` (:342), in order**
1. `leadStop(lead)` (:345). Any safety rule on the lead's own state stops the run (§3.4).
2. Quiet hours: deferred to their end.
3. `guard.check(... endOnAnswer: true)` (§3.5):
   - `wait` → look again at `until`.
   - `booked` → skip, then `appointmentBooked`.
   - `answered` → every remaining step is skipped `call_answered`, then `awaitScore` (:373).
4. If step 2 follows a call, it waits until `call.endedAt + after` (:380, `guard.lastCallEndedAt`).
5. `conditionUnmet(onlyIfOf(step))` (:389). It is skipped with reason + detail when unmet.
6. `run` (:398): SMS sent, or call queued with dedupe key `strategy:<leadId>:<enrolledAt>:<n>`. The run is recorded via `guard.record`.

**Answered call → score**
- `awaitScore` (:443) waits until `endedAt + SCORE_WAIT_MS` (15 min).
- If `qualified()` arrives first, it stops the run.
- If not, `scoreOverdue` (:449) flags the lead (`SCORE_MISSING_REVIEW`), exits the strategy to follow-up and enrols the sequence for its reason. A lead never hangs without one.
- `finalize` (:466), after the last step, holds the exit the same way while a call is live, queued or awaiting analysis.

**`qualified()` (:205)**
- Hot → `interested`, and **no sequence** (D4).
- Warm/cold → `follow_up` (`not_ready`, or `callback_requested` when asked). The sequence comes from `follow_up_<reason>`, else `qualified_<temp>`, via `enrolOrSwap` (:495, rule A4).
- The swap only replaces an `auto` enrolment in a different sequence. One already in the right sequence carries on; one the owner chose is left alone.
- It clears the score-missing flag.
- A callback request that no sequence picks up flags `CALLBACK_UNHANDLED_REVIEW` (:239).

**Other entry points**
- `appointmentBooked` (:247): a booking wins from **any status except `invalid`** (D2). It stops the run and every sequence.
- `endJourney` (:320): a call that said not interested / wrong number. It sets the status with the reason, stops the strategy and every sequence, and enrols nothing.
- Quick actions:
  - `setAutomationPaused` (:293): pause stops the strategy and pauses the sequence. Resume picks both back up. It refuses DNC leads and leads whose outreach never started.
  - `markBooked` (:309): refuses only `invalid`.
- Resume after a restart (`resume` :154): count-based as before (`remainingSteps` :22). A two-step strategy's next wait counts from `guard.lastRunAt`.

### 3.3 "Only if" (`backend/src/outreach/conditions.ts`, `frontend/src/utils/conditions.ts`)

**Stored shape:** `onlyIf: { match: 'all' | 'any', rules: [{ field, op, value }] }`. No rules means always.

**Fields** (after the YAGNI cleanup; context map at backend :36):

| Context | Fields |
|---|---|
| after_call (Call→SMS step 2) | `call_result` |
| after_sms (SMS→Call step 2) | `sms_reply` |
| sequence | `call_result`, `sms_reply` |

- `call_result` values: `no_answer`, `voicemail`, `busy`, `short_pickup`, `conversation`. Ops are `in` / `not_in`.
  - `failed`, `none` and `pending` are facts that never match `in`. A call that never connected, or was never placed, is never "not answered".
- `sms_reply` op is `is`; values are `replied` / `not_replied`, counted from strategy start or enrolment.
- `MAX_RULES = 10` is kept as an API input bound.

**Older single `condition` values** are mapped at read time and never rewritten (`onlyIfOf` backend :52, `onlyIfOfStep` frontend :72):

| Older value | Rule set |
|---|---|
| `always` | `[]` |
| `call_not_answered` | `call_result in [no_answer, voicemail, busy, short_pickup]` |
| `no_reply` | `sms_reply is not_replied` |
| `not_reached` | all of `call_result not_in [conversation]` and `sms_reply is not_replied` |

- Backend validation is `onlyIfError` (:73). Evaluation is `evaluate` (:104). A skip says why via `skipDetail` (:125), e.g. "The call result was a conversation".
- "The last call" means different things:
  - Strategy: the call of this run.
  - Sequence: the lead's last call ever (`callsSince: null`). This includes the strategy's call.

**The UI is a plain dropdown.** The owner decided it, overriding the builder. `PRESETS` is at frontend `conditions.ts:36`:

| Place | Options |
|---|---|
| Strategy Call→SMS | Always / Only if the call was not answered |
| Strategy SMS→Call | Always / Only if the lead hasn't replied |
| Sequences | Always / Only if the last call was not answered |

- `presetOf` (:66) reads a saved rule set back as its choice, whatever the order of its values.
- Anything else, e.g. an older `not_reached`, shows read-only as "Custom: …" and keeps running until the owner picks an option.

### 3.4 Safety rules (`backend/src/outreach/safety-rules.ts`)

`SAFETY_RULES` (:32) is the one list. The strategy and sequence screens render it from the API (`safetyRules`). A rule appears there only once code enforces it.

| Rule | Kind | Where enforced |
|---|---|---|
| A meeting is booked | never sends | `leadStop` (status), and `guard.check` (calendar meeting) |
| The lead replied by SMS | never sends | `leadStop` (`automationPaused`, set by any reply) |
| The lead opted out (STOP, or asked on a call) | never sends | `leadStop` (`dncStatus`) |
| The lead said they are not interested | never sends | `leadStop` (status `not_interested`) |
| Wrong or invalid number | never sends | `leadStop` (status `invalid`) |
| Agent paused automation | never sends | `leadStop` (`automationPaused`) |
| The lead is hot and with an agent | never sends | `leadStop` (`interested` / `appointment_requested`) |
| The lead is closed | never sends | `leadStop` (`closed`) |
| A call was answered (strategy only) | never sends | `guard.check(endOnAnswer)` |
| A call is ringing, live, queued or being checked | waits | `guard.check` |
| Outside contact hours | waits | engine / runner quiet-hours check |

- `leadStop` (:56) is used by `EngineService.fireStep` and `FollowupRunner.execute` (`backend/src/followup/followup.runner.ts:120`).
- In the runner, `opted_out` stops the enrolment, `automation_paused` pauses it, and any other rule stops it as `lead_<status>`.
- `safety-rules.spec.ts` proves both directions: every listed rule really stops a step, and every lead state that stops one is listed.

### 3.5 The step guard (`backend/src/outreach/step-guard.service.ts`, `StepGuardModule`)

The guard is provider-neutral: it reads the `calls` table, the step runs, the calendar meetings and the BullMQ call queue.

**Constants**
- `MIN_ANSWERED_SECONDS = 30` (:12)
- `SCORE_WAIT_MS = 15 min` (:17)
- `RINGING_STALE_MS = 5 min`, `IN_PROGRESS_STALE_MS = 30 min` (:19–20)
- `QUEUED_CALL_MAX_WAIT_MS = 24h` (:25)
- `RECHECK_MS = 60s` (:27)
- `CALL_ROW_LEEWAY_MS = 30s` (:29)

**`callResult` (:95), "answered" = a person was reached**
- `failed` → failed. `no_answer` (also busy and ring timeout) → not answered, decided at once.
- `completed`:
  - The analysis decides when there is one (`analysisVerdict` :119): `reached_person` first, else any conversation signal.
  - Answering machine detection saying `machine` → voicemail, decided at once.
  - A call picked up (`answered_at` set), unscored, within 15 min of hang-up → `awaiting_analysis`.
  - Otherwise ≥30s of talk (`answered_at`→`ended_at`; older rows use `duration_seconds`).
- A row still ringing after 5 min → not answered. One in progress after 30 min → answered, unless the analysis says no one was reached.

**`callOutcomeOf` (:130)** maps that to the condition facts:
- `busy` comes from `end_reason ∈ {user_busy, call_rejected, dial_busy}` (:126).
- `voicemail` comes from AMD `machine`, `reached_person: false` or `voicemail_reached` (:127).
- A connected but short call is `short_pickup`.

**`check()` (:165), in order**
1. Upcoming scheduled meeting linked to the lead → `booked`.
2. Any call live → `wait`.
3. A queued call step with no call row yet (`queuedCall` :324):
   - Its job is still pending in BullMQ → `wait`. The queue being unreadable counts as pending.
   - Pending for more than 24h → `stuck`. The lead is flagged `QUEUE_STUCK_REVIEW` and the step is skipped `call_still_queued`.
4. Any call awaiting analysis → `wait`.
5. An answered call in this run:
   - Strategy → `answered`.
   - Sequence → `go`, and the lead is flagged if it was answered by talk time alone with no score.

**Other methods**
- `conditionUnmet` (:194): reads only the facts the rules need (`factsFor` :216).
- `record` (:259): `createMany skipDuplicates` on `(lead_id, run_key)`. A lost record never stops or repeats a step.
- `flagReview` / `clearReview` (:282/:288): append or remove one reason in `leads.review_reasons` and keep `needs_review` in step. These show in the leads list attention icon and the dashboard "Flagged for review".

### 3.6 Follow-up sequences (`backend/src/followup/`)

**Runner `execute`** (`followup.runner.ts`): `leadStop` (:120) → quiet hours → `guard.check(endOnAnswer: false)` (:137) → condition (:148, `callsSince: null`) → fire → advance.
- A hold (`holdUntil` :201) gives back the claim's attempt, so waiting never counts as a failure.

**D1: last step is a call**
- After queuing it, the enrolment moves past the end and stays active, looked at again in 1 min (`advance` :212).
- `afterLastStep` (:235) waits out a call that is queued, live or awaiting analysis.
- `closeOut` (:246) completes the enrolment. It closes the lead as `not_interested` **only if the sequence never reached it** (no answered call, no reply).

**Service** (`followup.service.ts`)
- `stepOnlyIf` (:446) validates and maps each step's condition on save.
- `liveEnrollment` (:125) and `resumeForLead` (:206) are new.
- "Qualified as hot" (D4):
  - A new sequence cannot take it (`assertNoNewHotTrigger` :57).
  - An existing one keeps it, and `listSequences` returns `warnings` (:357).
  - The UI disables the checkbox and shows a badge.

### 3.7 Calls, scoring, SMS, booking (audit fixes)

| Fix | Where | Behaviour now |
|---|---|---|
| B1 | `telnyx/voice.service.ts:38`, `telnyx-webhook.controller.ts:43`, `activity.service.ts:188` | Every AI call dials with `answering_machine_detection: 'premium'`. `call.machine.premium.detection.ended` / `call.machine.detection.ended` → `calls.answered_by`: machine / silence / fax → `machine`; human_* / `not_sure` → `human`. |
| B11 | `activity.service.ts:24-36`, `:178` | `calls.end_reason` = Telnyx `hangup_cause`, with the SIP code folded in when unspecified (`endReasonOf`). `not_found` or SIP 404/410/484/604 → lead `invalid`. The old cause names Telnyx never sends are gone. |
| (answered_at) | `activity.service.ts:137` | `onCallAnswered` sets `answered_at`, so talk time excludes ringing. |
| B4 | `lead-scoring.service.ts:156` | Call said "not interested" (without asking for a meeting or a person) → `engine.endJourney(not_interested)`. |
| B5 | `lead-scoring.service.ts:154` | Wrong number / not a real enquiry → `endJourney(invalid)`. |
| B8 | `lead-scoring.ts:15/41/67`, `lead-scoring.service.ts:141` | New analysis field `do_not_contact`. When true → `setStatus(not_interested, optOut)`: DNC, every sequence stopped. This applies from any call and any status. Queued calls are dropped by the worker's DNC check. |
| (voicemail) | `lead-scoring.service.ts:133` | `reached_person: false` → the analysis is kept on the call, and the lead is not rescored or moved. |
| C2 | `inbound-sms.service.ts:11`, `:75` | START words are only `start` / `unstop` (what Telnyx honours), and only for a DNC lead. "Yes" or "Start" from anyone else is a normal reply: automation pauses. |
| B10 | `calendar/booking/in-call-booking.service.ts:184` | The lead is booked as soon as Calendly creates the invitee, even if reading the meeting back or recording it fails. |
| D2 | `engine.service.ts:247`, `step-guard.service.ts:251` | A booking wins from any status but `invalid`. This covers the calendar sync, in-call booking, a sequence step finding a meeting, and Mark as booked. |
| A4 | `telnyx/calls/call.worker.ts:64-72` | Before dialling, the worker checks the lead is still in what queued the call. A strategy call needs the lead in `new`/`contacting`. A sequence call needs its enrolment `active` (`enrollmentId` in the job; older jobs fall back to `sequenceId`). |

**Analysis schema**
- New fields `reached_person` and `do_not_contact` (`lead-scoring.ts`).
- The Telnyx Insight is re-sent with the current schema the first time each process needs it per org (`lead-insights.service.ts`, proven in `lead-insights-provision.spec.ts`). So **a deploy or restart picks the new fields up automatically** at each org's next call.
- The transcript fallback sends the schema with every request.
- Until then the fallback applies: conversation signals, then the 30s rule.

### 3.8 Lead page, dashboard, pacing

**Lead flow** (`GET /leads/:id/flow`, `portal.controller.ts:227`)
- Built from the step runs by `strategyFlowSteps` (`backend/src/outreach/strategy-flow.ts`). A skipped step shows "Skipped — <detail>".
- Leads from before step runs existed use the old call/text matching.
- It also returns `automationPaused` and `dncStatus` (:305) for the quick actions.

**Quick actions** (`backend/src/telnyx/lead-automation.controller.ts`, both audited)

| Endpoint | Audit action |
|---|---|
| `POST /leads/:id/automation {paused}` | `lead.automation_paused` / `lead.automation_resumed` |
| `POST /leads/:id/booked {note?}` | `lead.marked_booked`, with the note |

**UI**
- `frontend/src/components/modals/LeadDetailModal.tsx`: the buttons are at :223/:237. Skipped steps render as a dashed chip (`FlowSteps` :75), including after the strategy ended.
- Dashboard (`backend/src/lead/dashboard.controller.ts:51`): speed-to-lead now counts from the strategy's first step that really went (text sent / call queued), with a fallback to `first_contact_at`. The "Flagged for review" hint was reworded.
- Batch pacing (`backend/src/outreach/schedule.ts:69`, `awaitingWindowMs`): a two-step strategy's waits add up, so the step 1 delay counts.

### 3.9 Frontend files

| File | What |
|---|---|
| `components/views/StrategyEditor.tsx` | Two fixed cards: step 1 "start after" (:122) and step 2 wait + `ConditionSelect` (:137). Swap order, the older-strategy note, a summary line per card, and `SafetyRulesList` per card, collapsed (:163). An `smsUnavailableReason` prop for Retell orgs (call first, SMS card disabled). |
| `components/outreach/ConditionSelect.tsx` | The plain dropdown and its hint. Lists a non-preset saved condition as "Custom: …". |
| `components/outreach/SafetyRulesList.tsx` | "Never sends if (built in, always on)" and "Waits while", with a lock icon. Read-only, always collapsible. |
| `components/modals/SequenceEditorModal.tsx` | A `ConditionSelect` per step (:671) and the safety list (:678). The hot trigger is disabled with a note (:517). Older conditions are mapped on load (:110) and `onlyIf` is sent only when it has rules (:188). |
| `components/views/FollowUpsView.tsx` | A "never sends to hot leads" badge (:280). |
| `utils/strategiesApi.ts` | `getStrategyEditor`/`saveStrategySteps`, `swapOrder` (:83), `callFirst` (:91), `stepsError` (:94), `stepSummary` (:104), e.g. "This SMS goes 5 min after the call ends, only if the call was not answered." |
| `utils/conditions.ts` | `PRESETS`, `presetOf`, `onlyIfOfStep`, `ruleText`/`onlyIfText` (used for "Custom: …"). |
| `utils/sequencesApi.ts`, `utils/assistantApi.ts` | Types: step `onlyIf`, sequence `warnings`, flow `skipped` state, the quick-action calls. |

---

## 4. Data

**Migration `20261026000001_outreach_step_runs`**
- `calls.answered_at timestamptz`.
- New table `outreach_step_runs`:
  - Columns: `id`, `organization_id`, `lead_id`, `source` (`strategy` | `followup`), `enrollment_id`, `run_key`, `step_number`, `channel`, `outcome` (`sent` | `queued` | `failed` | `skipped`), `reason`, `call_key`, `created_at`.
  - Unique on `(lead_id, run_key)`.
  - Cascades with the lead and the org.
  - `run_key` is `strategy:<first_contact_at ms>:<step>` or `followup:<enrolment id>:<step>`.

**Migration `20261026000002_call_end_reason_amd`**
- `calls.end_reason varchar(40)` and `calls.answered_by varchar(20)`.
- `outreach_step_runs.detail varchar(300)`.

**Skip reasons** (`step-guard.service.ts:36`): `booked`, `call_answered`, `max_voice_attempts`, `call_unresolved`, `call_still_queued`, `condition_not_met` (with detail), `safety_rule`.

**Strategy JSON** (`org_settings.outreach_strategy`):
- `{ name, guardrails, steps: [{ id, after: { value, unit }, channel, message?, onlyIf? }], timing?: 'after_previous' }`.
- Older rows may carry `condition` and `guardrails.stopOn`. Both are read tolerantly; nothing reads `stopOn`.

**Sequence step JSON**: `{ actionType, delayMinutes, messageTemplate, voicePrompt, maxAttempts, onlyIf? }`. Older steps may have `condition`. Sequence delays always counted from the previous step; that is unchanged.

---

## 5. Decisions log (owner, in order)

**Round 1: scope**
- The strategy is exactly 2 steps (SMS + call). Only the order can change; no add/delete.
  - Step 1: wait 0, no condition.
  - Step 2: the other channel, "wait X after step 1", and a condition.
- `MAX_STRATEGY_STEPS = 2` is enforced in backend and UI, and the data stays a list.
- Older strategies are never rewritten. The editor shows a note and prefills the first call and first SMS in their real order. The new format applies on save.
- Retell orgs (no SMS): call only, with the step-2 card disabled and the reason shown.
- Sequences stay multi-step and get the safety rules + conditions.

**Decisions A, B and C**
- A. An answered call ends the strategy.
  - "Answered" = a person reached (talk time or analysis).
  - If no score arrives in 15 min, the lead is flagged for review and parked with its sequence.
  - A callback request must never be lost.
- B. Wait = after the previous step, with older data converted by real offsets and never negative.
- C. Safety rules: live-call guard, end on answer, booking check before every step, sequence swap on re-score, no call stacking.

**Round 2**
- The analysis is final for "answered". Without one, the duration rule applies.
- The analysis wait applies only to calls that were picked up (`answered_at`); a never-answered call is decided at once.
- A queued call is never "not answered":
  - The step waits as long as the job is pending, with no blind timeout.
  - After 24h the step is skipped with the reason and the lead flagged.
- The guard and flow helpers moved to `src/outreach/` as a provider-neutral module.
- New default strategy: Call → SMS 5 min, "only if not answered", the text in §3.1.

**Round 3: audit (Phase 3.5)**
- B4, B5, B8, D1, D2, B10, C2, B11, B1, A4 and D4, as in §3.7 / §3.6.
- B1: starting the AI only on a "human" AMD result was a proposal only; it is **not built**.

**Round 3: redesign**

| Decision | Status |
|---|---|
| Step 2 after a call counts from the call's end; SMS→Call from the SMS being sent | Implemented |
| Step 1 "start after", default 0, max 12h, contact window applies | Implemented. Speed-to-lead counts from the first real step run. |
| Label "Agent paused automation" | Implemented |
| Visible safety rules from one source of truth, only rules the code enforces | Implemented. "Not interested" and "wrong number" were added after B4/B5. |
| Plain-English summary under each card, updated live | Implemented |
| Condition builder: AND/OR, fields by context (Call→SMS: call result, lead source, day; SMS→Call: SMS reply, lead source, day; sequences: all of them plus temperature) | Built, then **replaced by the plain 2-option dropdown at the owner's request** ("bht jada technical"). The fields no UI could produce (lead source, temperature, day) were then removed. |
| Lead source rule: a group by type (future sources included) or a specific source | Built, then **removed** with the builder. Re-add from the git history of this branch's working state only if the owner asks. |
| "Call result: conversation happened" allowed; booked / not interested / DNC still stop it (the step waits for the score, then goes before the sequence) | Built, then **removed**: the dropdown cannot choose it. The API still accepts `conversation` as a value, but nothing waits for a score on its behalf any more. |

**Small UI follow-ups**
- Step 1's safety list is collapsible like step 2's.
- The "0 = as soon as…" hint was removed.

**Standing rules from the owner**
- App, UI and API text is English only. Explanations to the owner are in Hinglish.
- Additive changes only; existing behaviour must not break.
- Never commit unless asked; never push unless asked.
- Owner UIs stay simple: presets over builders (see `simple-owner-ui` in the session memory).

---

## 6. Known limits

- **Analysis wait cost.** A picked-up call with no analysis holds the next step up to 15 min. Orgs with recording off and no Insight see the "not answered" SMS about 15 min in, not 5.
- **Voicemail with AMD and detection both off.** If the AI talks to a voicemail for over 30s and no analysis comes, the call counts as answered.
- **Bookings are seen only once the calendar sync records them.** Instant detection needs `CALENDAR_WEBHOOK_BASE_URL` (§8). Calendly's free plan has no webhooks, so those orgs rely on the 5-minute poll.
- **Leads in the strategy before deploy** have no step runs. Their lead flow uses the old call/text matching, and the guard cannot see their pre-deploy queued calls.
- **Premium AMD** is a paid Telnyx add-on and now runs on every AI call.
- **Telnyx LLM opt-out.** Its natural-language opt-out ("leave me alone", release note 15 Oct 2026) blocks SMS on Telnyx's side. The app sees an ordinary reply: automation pauses, but `dnc_status` is not set.
- **AI vs AMD timing.** Master's `AI_OPENING_WAIT_MS` starts the AI on the lead's first words. A voicemail greeting counts as words, so the AI may speak to a machine before AMD reports. The proposal is to hold the AI until AMD says `human` (not built).
- **Sequences keep their old timing:** "after X min" counts from when the previous step fired, not from a call's end. Only the strategy counts from the call's end.

---

## 7. After the Retell merge (`feature/retell-provider`, 9880ef4, pushed)

- **SMS skip reason.** Re-add `sms_unavailable` to `SkipReason` and `SKIP_LABELS`; it was removed as unused. Record it when the provider has no SMS, in the engine and the runner (Retell skips SMS steps through `providers.for()`).
- **Retell analysis.** Map `call_analysis.in_voicemail` to `reached_person` in `extractionFromRetell`. Map `user_requested_dnc` / `do_not_contact` the same way.
- **Retell dead numbers.** The Retell branch added `invalid_destination` to the old `INVALID_NUMBER_CAUSES`. Fold it into `endReasonOf` / dead-number handling instead.
- **Retell busy and voicemail.** `dial_busy` and `voicemail_reached` are already in `BUSY_REASONS` / `VOICEMAIL_REASONS` (`step-guard.service.ts:126-127`). Make sure the Retell webhook writes them to `calls.end_reason`.
- **Editor.** Pass `smsUnavailableReason` to `StrategyEditor` for Retell orgs, then test the single-step Retell strategy, which was not possible on master.
- **Expected small conflicts:**
  - `engine.service.ts`: constructor (`sms` vs `providers`) and the SMS send in `run`.
  - `followup.runner.ts`: `fire`.
  - `portal.controller.ts`: the lead flow.
  - `activity.service.ts`: `onCallAnswered`, `onCallHangup`, the `startCall`/`recordCallFailed` provider param.
  - `call.worker.ts`: the dial call, plus the new A4 check.
  - Both branches add specs under different names, so there are no add/add conflicts.

---

## 8. Deploy checklist

- [ ] `npx prisma migrate deploy` (two additive migrations).
- [ ] Stop the backend, run `npx prisma generate`, then start it. The Telnyx Insight picks up `reached_person` / `do_not_contact` at each org's next call.
- [ ] Set `CALENDAR_WEBHOOK_BASE_URL` (the public https API address) in the production backend `.env`. Without it, bookings are found only by the 5-minute poll. Calendly free-plan orgs have no webhooks either way. Cal.com's plan rules are unconfirmed; check on a live account.
- [ ] Confirm premium AMD cost and availability on the Telnyx account.
- [ ] Check each org's AI Settings → "Detect voicemail" (assistant-level; owner-set; default off). It is independent of call-level AMD.
- [ ] Tell owners: an older strategy keeps running as it is until they open and save it in the new two-step form.

---

## 9. Tests

**Baseline on master aaf9e84**, before this work:

| Suite | Result |
|---|---|
| Backend unit | 25/25 |
| `outreach-schedule.int.ts` | 21/21 |
| Backend tsc (tracked files) | clean |
| Frontend unit | 105/110 |
| Frontend tsc | 2 errors (strays) |

The strays are untracked files listed in `.git/info/exclude`: `backend/src/modules/*.test.ts` (91 tsc errors) and `frontend/src/components/**/{LeadsView,LeadDetailModal,…}.spec.tsx` (the 5 frontend failures and the 2 tsc errors). They come from another lineage; leave them.

**Now:** backend unit 258/258; integration 30/30 + 21/21 (last recorded); frontend unit 125/130 (strays only); builds ok.

**Existing test expectations that changed on purpose**
- `outreach/schedule.spec.ts`: `awaitingWindowMs(default)` went 6 → 5 min, because the default now calls at once.
- Characterization specs written in this work flipped where a decision changed behaviour: re-score swap (A4), hot enrols nothing (D4), `endReason` on the hang-up row (B11), `enrollmentId` in the call job (A4), and Mark as booked refusing only invalid (D2).

**Spec map**

| Area | Specs |
|---|---|
| Characterization of the old behaviour, still green | `telnyx/engine-steps.spec.ts`, `followup/followup-runner-steps.spec.ts`, `telnyx/activity-calls.spec.ts` |
| Safety rules and guard | `telnyx/engine-safety.spec.ts`, `followup/followup-runner-safety.spec.ts`, `outreach/step-guard.spec.ts`, `outreach/safety-rules.spec.ts` |
| Two-step strategy and redesign | `telnyx/engine-two-step.spec.ts`, `telnyx/engine-redesign.spec.ts`, `telnyx/strategy-store.spec.ts`, `outreach/conditions.spec.ts`, `outreach/schedule-two-step.spec.ts`, `outreach/strategy-flow.spec.ts` |
| Audit fixes | `telnyx/lead-scoring-outcomes.spec.ts`, `telnyx/lead-scoring-reached.spec.ts`, `telnyx/engine-booking.spec.ts`, `calendar/booking/in-call-booking-booked.spec.ts`, `telnyx/inbound-sms-keywords.spec.ts`, `telnyx/voice-amd.spec.ts`, `telnyx/calls/call.worker.spec.ts` (A4 block), `followup/followup-hot-trigger.spec.ts`, `telnyx/lead-insights-provision.spec.ts` |
| Real DB | `outreach/conditional-outreach.int.ts` |
| Frontend | `utils/strategiesApi.spec.ts`, `utils/conditions.spec.ts` |

`conditional-outreach.int.ts` covers call→SMS and SMS→call in every outcome, swap, booked, older strategies, sequences, review flags, tenant isolation, start after, wait from call end, busy/voicemail conditions, and the audit fixes against the DB.

**Integration-suite rules**
- Every test makes its own org and deletes it.
- Test phones are unique per run (`phoneSeq`), because texts are matched by phone.
- Wait on step-run rows, not on texts: the fake SMS records before the row is written.
- Keep a live call shorter than the next step's first check, because a held step looks again only after `RECHECK_MS` (60s).
