# Conditional outreach: handoff

Branch `feature/conditional-outreach`, as of 2026-10-27.

The branch is built on `origin/master` 3180897 (which includes the "AI opening wait" from `feature/human-takeover`). It carries two commits of its own: a237ab4 (the feature, phases 1–5) and the review-fix commit this file describes. It is **not pushed**.

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
| | **Review fixes (this commit):** H1 resume from the step record + stable call keys; M1 one-way call row moves; M2 12-hour cap on step 2 + long timers in pieces; M3 retry with backoff, give-up with a flag, watcher resumes every poll; M4 queue-read timeout; L1 lead scope on the quick actions; L2 lead re-checked right before a send; L3 honest label; L4 step-1 start kept; L5 fired timers dropped. |
| | **Rollout flag** `CONDITIONAL_OUTREACH_ENABLED` (default off): see §3.0. |
| | **"Detect voicemail"** in AI Settings drives call-level answering machine detection once an owner changes it (until then an office's assistant-level detection stands, as before), with "Hang up" or "Leave a short voicemail": see §3.7. |
| Migrations | `20261026000001_outreach_step_runs` and `20261026000002_call_end_reason_amd`. Both additive, both applied to the dev DB `estate_manish`. **No new migration in this commit**: the voicemail settings live in the strategy's guardrails JSON (§4). |
| Feature flag | `CONDITIONAL_OUTREACH_ENABLED` (backend `.env`). Off: the strategy, the engine, the sequence runner and the strategy screen behave as before this feature. The audit bug fixes stay on either way. |
| Tests at commit | Backend: tsc clean on tracked files, unit 301/301. Integration: `conditional-outreach.int.ts` 36/36, `outreach-schedule.int.ts` 21/21. |
| | Frontend: unit 130/135 (the 5 failures are the stray `LeadsView.spec.tsx`), tsc 2 errors in strays, build ok. |
| UI verification | Not done in a browser. The strategy screen has a jsdom component test (`StrategyEditor.spec.tsx`); the rest was checked by tests and the owner's own screenshots. |

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
npm install          # jsdom + @testing-library/react were added for the component test
npx tsc --noEmit     # 2 errors, both in stray specs (LeadDetailModal.spec.tsx, LeadsView.spec.tsx)
npx vitest run       # 5 failures, all in the stray LeadsView.spec.tsx
npx vite build
```

To see the feature in dev, set `CONDITIONAL_OUTREACH_ENABLED=1` in `backend/.env` and restart the backend. Without it the app runs the older strategy editor and engine.

**Environment gotchas**
- The owner's dev server often runs from this folder (`nest start --watch` on :4000, with `STRATEGY_ENGINE=1` and the call worker on). It picks up edits live, including anything that places real calls. It was running (pid on :4000) throughout the review-fix session; that is why no new Prisma column was added (`prisma generate` would have needed it stopped).
- The integration suites never boot Nest. They build services by hand: no lead watcher, no runner poll, no call worker. The SMS and call queue are stand-ins, and the follow-up runner only gets the suite's own enrolment through `execute()`. The step guard, the engine, the activity service and the Telnyx webhook controller are real.
- On Windows, bash heredocs mangle quotes and backslashes. Patch files with a node script and keep CRLF endings. `core.autocrlf=true` normalises them on commit.

---

## 3. Current behaviour

### 3.0 The rollout flag (`CONDITIONAL_OUTREACH_ENABLED`)

Read once at boot by `StrategyStoreService.conditional`, `EngineService`, `FollowupRunner` (all from `ConfigService`).

| | Off (default) | On |
|---|---|---|
| Default strategy for an office that never saved one | The older three steps: text at once, call a minute in, text at five minutes (`legacyDefaultStrategy`). | Call at once, text 5 min after it ends, only if not answered. |
| Saving a strategy | Stored as sent, any number of steps, no `timing`. | Two-step rules (`validateTwoStep`), `timing: 'after_previous'`. |
| `GET/PUT /strategy` | `{ strategy }` only. | `{ strategy, editor, safetyRules }`. |
| Strategy screen | The older free-form list (`LegacyStrategyEditor` in `StrategyEditor.tsx`), chosen because `editor` is absent. | Two fixed cards + Swap order. |
| Sequence editor | No "Only if" dropdown, no safety list (they would do nothing). | Both shown. |
| Engine | No step guard, no conditions, no step record; every strategy (a saved two-step one included) timed from enrolment; resume from calls/texts on record. | Guard, conditions, record, two-step timing, resume from the step record. |
| Sequence runner | No guard, no conditions, no record; an exhausted sequence closes every lead as not interested (as before). | Guard, conditions, record; only a lead never reached is closed out. |
| Always on, either way | A4 (worker enrolment check), B1 → now the voicemail setting (§3.7), B4/B5 (not interested / wrong number from a call), B8 (DNC from a call), B10, B11 (dead numbers), C2 (START words), D2 (booking from any status), D4 (hot trigger), `reached_person: false` leaves the lead where it is, the quick actions, the call row's one-way moves (M1). | |

Characterization specs for "off": `engine-steps.spec.ts` (last describe), `strategy-store.spec.ts` (last describe), `followup-runner-safety.spec.ts` (last describe).

### 3.1 The strategy (new leads)

**Shape** (`backend/src/telnyx/strategy-store.service.ts`)
- Exactly `MAX_STRATEGY_STEPS = 2` steps: one `voice` and one `sms`, in either order.
- Step 1 waits `after` from when the lead comes in. Step 2 waits `after` from the end of step 1 (a call: from when it **ends**; a text: from when it is **sent**).
- **Either wait is at most `STEP_MAX_DELAY_MS` = 12h** (review fix M2; before, only step 1 was capped). Past a day the lead watcher would park an in-strategy lead as stalled.
- Step 2 carries `onlyIf` (§3.3). Step 1 never has a condition.
- A strategy the editor saves carries `timing: 'after_previous'`.
- `guardrails.voicemail` carries the voicemail settings (§3.7, §4); the engine never reads it.

**Validation**: `validateTwoStep` checks two steps of different channels; each wait 0–12h; no condition on step 1; step 2's `onlyIf` passes `onlyIfError` for its context; an SMS step has a message. `saveStrategy` saves through `asEditable`. A save of only `guardrails`/`name` leaves the steps and `timing` untouched (ContactWindowCard and the voicemail setting rely on this).

**Older strategies** (no `timing`, any number of steps, waits counted from enrolment)
- Never rewritten; run as they always did.
- `toTwoStep` is only the editor's view: the first call and the first SMS, in the order they really ran. **The first keeps its own start** (review fix L4; before it was forced to 0), the second waits the real gap after it. Each is capped at 12h; `converted` is true when anything was changed or capped.

**Default for an org that never saved one** (`defaultStrategy(conditional)`): with the flag on, Call at 0 then SMS 5 min after the call ends, "Only if the call was not answered"; with it off, the older three-step text.

**API** (`portal.controller.ts`): `GET`/`PUT /strategy` return `{ strategy, editor: toTwoStep(strategy), safetyRules }` with the flag on, `{ strategy }` without.

### 3.2 The engine (`backend/src/telnyx/engine.service.ts`)

**Scheduling**: steps run strictly in order: one timer, then the next step is scheduled (`scheduleNext`). Older strategies are timed from enrolment plus the quiet-hours shift; two-step strategies from `lastRanAt`.
- `later()` takes a wait longer than `MAX_TIMER_MS` (2^31−1 ms, ~24.8 days) in pieces, so an older strategy's 30-day step fires when due, not at once (review fix M2). A timer that fired is dropped from `e.timers` (L5).

**`fireStep`, in order**
1. `leadStop(lead)`: any safety rule on the lead's own state stops the run (§3.4).
2. Quiet hours: deferred to their end.
3. *(flag on)* `guard.check(... endOnAnswer: true)` (§3.5): `wait` → look again at `until`; `booked` → skip, then `appointmentBooked`; `answered` → every remaining step is skipped `call_answered`, then `awaitScore`.
4. *(flag on)* If step 2 follows a call, it waits until `call.endedAt + after`.
5. *(flag on)* `conditionUnmet(onlyIfOf(step))`: skipped with reason + detail when unmet.
6. **The lead is read once more** (review fix L2): a reply, booking, opt-out or pause that came in while 3–5 ran stops the run; nothing is recorded, so a later resume runs the step then.
7. `run`: SMS sent, or call queued with dedupe key **`strategy:<leadId>:<firstContactAt ms>:<stepNumber>`** (review fix H1: stable across a resume or retry; before it carried the in-memory `enrolledAt`, which changed on resume). The run is recorded via `guard.record` (flag on).

**Resume after a restart or a drop** (`resume`)
- *(flag on, two-step)* **Reads the step record** (`guard.stepRuns`, review fix H1): a step with any run (sent / queued / failed / skipped) is not run again; the next wait counts from the last run. The calls on record would not do: a call still waiting in the queue has no row yet and was being queued a second time.
- Older strategies: count-based as before (`remainingSteps`).
- `enroll` holds the lead in `starting` from the claim until its strategy is loaded, so a watcher poll cannot resume it in between. If loading fails after the claim, the lead stays claimed and not running; the watcher resumes it.

**Errors** (review fix M3): a step (or `finalize`/`scoreOverdue`) that throws is retried with backoff (`STEP_RETRY_BASE_MS` 10s doubling, cap `STEP_RETRY_MAX_MS` 5 min). After `MAX_STEP_FAILURES` (5) the lead is flagged `STEP_FAILED_REVIEW`, exited to follow-up and enrolled in its sequence (`giveUp`); it leaves `active` first, so if even that fails the watcher picks it up. `LeadWatcherService` now resumes, **on every poll**, any in-flight lead the engine is not running (`engine.isRunning`), not only on boot.

**Answered call → score**: `awaitScore` waits until `endedAt + SCORE_WAIT_MS` (15 min); `scoreOverdue` flags and parks the lead with its sequence. `finalize` holds the exit the same way while a call is live, queued or awaiting analysis (flag on).

**`qualified()`**: hot → `interested`, no sequence (D4). Warm/cold → `follow_up` with the sequence from `follow_up_<reason>` else `qualified_<temp>`, via `enrolOrSwap` (only an `auto` enrolment in a different sequence is swapped). A callback request no sequence picks up flags `CALLBACK_UNHANDLED_REVIEW`.

**Other entry points**: `appointmentBooked` (D2, any status but invalid), `endJourney` (not interested / wrong number from a call), `setAutomationPaused` (pause stops the strategy and pauses the sequence; resume picks both up, through `resume()` → the step record), `markBooked`.

### 3.3 "Only if" (`backend/src/outreach/conditions.ts`, `frontend/src/utils/conditions.ts`)

Unchanged by the review. Stored shape `onlyIf: { match, rules: [{ field, op, value }] }`; fields by context: after_call → `call_result`; after_sms → `sms_reply`; sequence → both. `call_result` values `no_answer`, `voicemail`, `busy`, `short_pickup`, `conversation` (`failed`/`none`/`pending` never match `in`). Older single `condition` values are mapped at read time (`onlyIfOf`). The UI is a plain dropdown (`PRESETS`); anything else shows read-only as "Custom: …".

### 3.4 Safety rules (`backend/src/outreach/safety-rules.ts`)

`SAFETY_RULES` is the one list the strategy and sequence screens render (flag on). `leadStop` is used by the engine (twice per step: before deciding, and right before sending) and by the runner (`liveLead`, likewise twice).

| Rule | Kind | Where enforced |
|---|---|---|
| A meeting is booked | never sends | `leadStop` (status), and `guard.check` (calendar meeting) |
| **The lead replied by SMS (until you resume automation)** | never sends | `leadStop` (`automationPaused`, set by any reply). Review fix L3: "Resume automation" lifts the pause, reply or not; the label now says so. |
| The lead opted out (STOP, or asked on a call) | never sends | `leadStop` (`dncStatus`) |
| The lead said they are not interested / Wrong or invalid number / Agent paused automation / The lead is hot and with an agent / The lead is closed | never sends | `leadStop` |
| A call was answered (strategy only) | never sends | `guard.check(endOnAnswer)` |
| A call is ringing, live, queued or being checked | waits | `guard.check` |
| Outside contact hours | waits | engine / runner quiet-hours check |

### 3.5 The step guard (`backend/src/outreach/step-guard.service.ts`, `StepGuardModule`)

Provider-neutral: reads the `calls` table, the step runs, the calendar meetings and the BullMQ call queue.

**Constants**: `MIN_ANSWERED_SECONDS` 30, `SCORE_WAIT_MS` 15 min, `RINGING_STALE_MS` 5 min, `IN_PROGRESS_STALE_MS` 30 min, `QUEUED_CALL_MAX_WAIT_MS` 24h, `RECHECK_MS` 60s, `CALL_ROW_LEEWAY_MS` 30s, **`QUEUE_READ_TIMEOUT_MS` 5s** (review fix M4: a look at the queue that outlasts it counts as the job still waiting, like an unreadable queue; before, a hanging Redis held the runner's tick).

**`callResult`**: "answered" = a person was reached. `failed` → failed; `no_answer` → not answered at once; `completed`: the analysis decides when there is one (`reached_person` first, else any conversation signal), else AMD `machine` → not answered at once, else a picked-up unscored call within 15 min of hang-up → `awaiting_analysis`, else ≥30s of talk. A pick-up recorded after the hang-up (`answeredAt > endedAt`, events out of order) is no pick-up (review fix M1). Rows stuck ringing/in progress are treated as ended.

**`check()`**: upcoming meeting → `booked`; any live call → `wait`; a queued call step with no row yet whose job is still pending → `wait` (past 24h → `stuck`, lead flagged `QUEUE_STUCK_REVIEW`); any call awaiting analysis → `wait`; an answered call in this run → `answered` (strategy) or `go` (sequence, flagged if answered by talk time alone with no score).

**Other methods**: `conditionUnmet`, `lastCallEndedAt`, **`stepRuns(leadId, prefix)`** (this run's record, oldest first; replaces `lastRunAt`), `isScoredCall`, `markBooked`, `record` (`createMany skipDuplicates`), `flagReview`/`clearReview`.

### 3.6 Follow-up sequences (`backend/src/followup/`)

**Runner `execute`**: `liveLead` (`leadStop`) → quiet hours → *(flag on)* `guard.check(endOnAnswer: false)` → condition (`callsSince: null`) → **`liveLead` again right before the send** (review fix L2: a reply or booking seconds ago still holds; the enrolment is paused or stopped accordingly, nothing recorded) → fire → advance. A hold gives back the claim's attempt.

**D1**: after a last-step call the enrolment stays open until the call has an outcome (`afterLastStep`, flag on). `closeOut` completes it and closes the lead as `not_interested` only if the sequence never reached it (flag on); with the flag off every exhausted lead is closed, as before.

**Service**: `stepOnlyIf` validates each step's condition on save; `liveEnrollment`, `resumeForLead`; D4 (hot trigger refused on new sequences, warned on existing ones).

### 3.7 Calls, scoring, SMS, booking

**The call row moves one way** (`activity.service.ts`, review fix M1)
- `onCallAnswered`: `updateMany` where status ∈ {queued, ringing} → `in_progress` + `answeredAt`. Zero rows (a hang-up got there first, or the same event again) → nothing else happens and **nothing is attached to the dead call**.
- `onCallHangup`: one atomic SQL `UPDATE … CASE WHEN status = in_progress THEN completed ELSE no_answer END … WHERE status IN (queued, ringing, in_progress) RETURNING status`. Zero rows (the same hang-up twice) → nothing else happens. So a short pick-up whose answered and hang-up events race ends `completed` (answered first) or `no_answer` (hang-up first), never stuck `in_progress`.
- Covered by `activity-calls.spec.ts` and, against the real DB with the real webhook controller, by the "end to end" and "M1" tests in `conditional-outreach.int.ts`.

**"Detect voicemail"** (AI Settings; `voicemailOf` in `strategy-store.service.ts`, stored in `guardrails.voicemail`)
- **Nothing changes for any office until its owner changes the setting.** An office that never saved it keeps its assistant's own Telnyx-side `voicemail_detection` exactly as it was, and the screen shows that value (`AssistantService.effectiveVoicemail`: the saved setting, else the assistant's). An unrelated AI Settings save, or the screen sending back what it showed, touches neither. Only when the owner changes the toggle, the action or the message is the setting saved with the strategy and the assistant-level detection set to `null`, so one mechanism acts on a machine: the call-level one below. (`assistant-voicemail.spec.ts`.)
- Not saved, or saved off: `VoiceService.placeCall` sends no `answering_machine_detection`; a voicemail is caught by the assistant's own detection (if it has it) or by the analysis (`reached_person: false`), as before.
- On: every AI call is dialed with `answering_machine_detection: 'premium'` (a per-call charge, see §6). On `call.machine.premium.detection.ended`:
  - `human_residence` / `human_business` / **`not_sure` → `answered_by: human`**, the assistant carries on.
  - `machine` / `silence` / `fax_detected` → `answered_by: machine`; the assistant is silenced (dropped while still waiting for the lead's first words, `ai_assistant_stop` once started), then
    - **Hang up** (default): `hangup`.
    - **Leave a short voicemail**: the owner's message ({{firstName}}, {{brokerage}} filled, ≤ 300 chars, default "Hi {{firstName}}, this is {{brokerage}} calling about your home search. We'll send you a quick text.") is spoken (`speak`, basic service level, `female`, en-US) once `call.machine.premium.greeting.ended` reports `beep_detected` (a beep heard before the verdict counts), then `hangup` on `call.speak.ended`. `no_beep_detected` → `hangup`.
  - Either way the row says a machine answered, so `callResult` is "not answered" **at once** (no 15-minute analysis wait) and the step-2 "not answered" SMS goes at its own time. `callOutcomeOf` → `voicemail`.
- Note (unsure, not tested on a live call): whether Telnyx premium AMD and `ai_assistant_start` on the same call interact (e.g. the detection's audio analysis while the assistant speaks). The AI may also start talking to the greeting before the verdict arrives (the opening wait starts the assistant on the first words it hears); the verdict then stops it.
- Specs: `voice-amd.spec.ts` (off = no param; on = premium), `activity-calls.spec.ts` ("answering machine detection": not sure, hang up, leave message with variables, beep before verdict, no beep), the int test "voicemail detection: a machine answered → the text goes at its own time".

**Analysis schema, audit fixes**: as before — `reached_person`, `do_not_contact` (B8), B4/B5 via `endJourney`, B11 via `endReasonOf`, C2 START words only for DNC leads, B10 booked on invitee creation, A4 worker enrolment check, D2.

### 3.8 Lead page, dashboard, pacing

- **Lead flow** (`GET /leads/:id/flow`): built from the step runs when there are any (flag on), else the old call/text matching. Returns `automationPaused` and `dncStatus` for the quick actions.
- **Quick actions** (`lead-automation.controller.ts`): `POST /leads/:id/automation {paused}` and `POST /leads/:id/booked {note?}`, `LEAD_UPDATE`, audited. **Scoped with `visibleLeads(auth)`** (review fix L1): an agent who sees only their own leads can act only on those; an owner on the organization's. Specs: `lead-automation.controller.spec.ts` (the real `PermissionsGuard` against the handlers + the scope), the int tests "tenant isolation" and "L1".
- Dashboard speed-to-lead counts from the strategy's first step that really went, with a fallback to `first_contact_at`. Batch pacing adds a two-step strategy's waits up.

### 3.9 Frontend files

| File | What |
|---|---|
| `components/views/StrategyEditor.tsx` | Two fixed cards + Swap order (flag on), or `LegacyStrategyEditor` (the editor from before, in the same file) when the payload has no `editor`. `smsUnavailableReason` prop for Retell orgs. |
| `components/views/StrategyEditor.spec.tsx` | jsdom component test: cards + summaries + rules, swap + save payload, validation before Save, the older-strategy note, the legacy mode. Needs `jsdom`, `@testing-library/react`, `@testing-library/dom` (devDependencies added). |
| `components/views/AISettingsView.tsx` | "Detect voicemail" toggle with its cost note; "When voicemail is detected": Hang up / Leave a short voicemail; the message textarea (≤ 300). |
| `components/outreach/ConditionSelect.tsx`, `SafetyRulesList.tsx` | As before. |
| `components/modals/SequenceEditorModal.tsx` | "Only if" + safety list shown only when the server sent `editor` (flag on). |
| `utils/strategiesApi.ts` | `editor?`/`safetyRules?` optional, `emptyStep` (legacy editor), `STEP_MAX_DELAY_MS`, `stepsError` with the step-2 cap. |
| `utils/assistantApi.ts` | `voicemail_message`, `DEFAULT_VOICEMAIL_MESSAGE`, `VOICEMAIL_MESSAGE_MAX`. |
| `utils/conditions.ts`, `utils/sequencesApi.ts` | As before. |

---

## 4. Data

**Migrations** (unchanged): `20261026000001_outreach_step_runs` (`calls.answered_at`, table `outreach_step_runs` unique on `(lead_id, run_key)`), `20261026000002_call_end_reason_amd` (`calls.end_reason`, `calls.answered_by`, `outreach_step_runs.detail`).

**Strategy JSON** (`org_settings.outreach_strategy`): `{ name, guardrails, steps: [...], timing?: 'after_previous' }`.
- `guardrails.voicemail?: { detect: boolean, action: 'hangup' | 'leave_message', message: string }` — the AI Settings voicemail setting (§3.7). Absent = never saved: no call-level detection, the assistant's own stands (`voicemailSettingOf` → null; `voicemailOf` → off). `ponytail:` kept in the guardrails JSON to avoid a migration while the dev server held the Prisma DLL; move to columns if more call-level settings accrue.
- Older rows may carry `condition` on steps and `guardrails.stopOn`; both are read tolerantly, nothing reads `stopOn`.

**Call dedupe key** (BullMQ job id): `strategy:<leadId>:<firstContactAt ms>:<stepNumber>` (strategy), `followup:<enrolment id>:<step>` (sequences).

**Skip reasons**: `booked`, `call_answered`, `max_voice_attempts`, `call_unresolved`, `call_still_queued`, `condition_not_met` (with detail), `safety_rule` (in the type; not written by anything yet).

**Review flags** (`leads.review_reasons`): `SCORE_MISSING_REVIEW`, `CALLBACK_UNHANDLED_REVIEW`, `QUEUE_STUCK_REVIEW`, **`STEP_FAILED_REVIEW`** (new: a step kept failing, the lead was parked).

---

## 5. Decisions log (owner, in order)

**Round 1: scope** — exactly 2 steps (SMS + call), only the order changes; step 1 wait 0 and no condition; step 2 the other channel with a wait and a condition; older strategies never rewritten; Retell orgs call-only; sequences stay multi-step.

**Decisions A, B, C** — an answered call ends the strategy (analysis or talk time; 15-min score wait then flag); wait = after the previous step; safety rules: live-call guard, end on answer, booking check, re-score swap, no call stacking.

**Round 2** — analysis is final for "answered"; the analysis wait only for picked-up calls; a queued call is never "not answered" (24h cap); guard/flow in `src/outreach/`; new default Call → SMS 5 min "only if not answered".

**Round 3** — audit fixes B4, B5, B8, D1, D2, B10, C2, B11, B1 (proposal only then), A4, D4; the redesign (waits from the call end, start-after capped at 12h, "Agent paused automation", visible rules, plain summaries); the condition builder replaced by the 2-option dropdown.

**Round 4 (2026-10-27): the review** — the owner asked for every merge blocker from the review to be fixed test-first, a rollout flag, and the voicemail setting:
- H1, M1, M2, M3, M4, L1, L2, L4, L5 fixed as in §3.
- L3: label, not behaviour ("The lead replied by SMS (until you resume automation)"). Simpler and honest: a resume is the owner's own choice to send again.
- Flag `CONDITIONAL_OUTREACH_ENABLED`, default off; the audit bug fixes stay on.
- "Detect voicemail": the existing AI Settings toggle drives call-level premium AMD; "Hang up" or "Leave a short voicemail" with an editable message; `not_sure` = human. Premium implemented; basic vs premium comparison left to the owner (§6).
- **Round 4b:** an office whose assistant-level detection was already on must not change silently: that value is the starting value (shown on the screen), an unrelated save never touches it, and only the owner's own change of the toggle/action/message moves voicemail to the call.
- Backlog L6–L14 recorded in §6, not fixed.
- One commit, not pushed.

**Standing rules from the owner**
- App, UI and API text is English only. Explanations to the owner are in Hinglish.
- Additive changes only; existing behaviour must not break.
- Never commit unless asked; never push unless asked.
- Owner UIs stay simple: presets over builders.

---

## 6. Known issues (backlog, from the review; not fixed)

| | Where | What | Suggested fix |
|---|---|---|---|
| L6 | `common/utils/quiet-hours.ts` `nextAllowedAt` | Quiet-hours deferral adds wall-clock minutes as real milliseconds, so across a DST change a deferred step lands an hour early or late. Pre-existing; the two-step path now uses it too. | Compute the end of the quiet window as a zoned date (Intl parts → UTC) rather than adding minutes. |
| L7 | `step-guard.service.ts` `callResult` (`IN_PROGRESS_STALE_MS`) | A call genuinely longer than 30 min is taken as ended and "answered"; a sequence step can fire during it. | Only treat a row as stale when the provider has no live call for it (check Telnyx), or raise the limit per the assistant's `max_call_secs`. |
| L8 | `engine.service.ts` `resume` / step numbers | A strategy edited while a lead is in flight, then a restart: the resume counts the new steps against the old run's record, so step numbers in `outreach_step_runs` and the lead flow can mislead. | Store the strategy's shape (or a hash) with the run and start a fresh run key when it changed. |
| L9 | `followup.runner.ts` `closeOut` | A lead the sequence reached stays in `follow_up` with no sequence and no flag once the sequence ends (D1 design). | Flag the lead for review, or enrol a configurable "after sequence" trigger. |
| L10 | strategy SMS text | A Call → SMS text deferred by quiet hours to the next morning still says "just tried you". | Let the SMS carry two texts (same-hour / later), or defer the whole step. |
| L11 | several | Dead code: `SkipReason 'safety_rule'` is never written; `smsUnavailableReason` is not passed by anything until the Retell merge; the API still accepts `call_result: conversation` which the UI cannot pick; `onlyIfOf` / `NOT_ANSWERED` are duplicated in backend and frontend. | Delete or wire each; generate the frontend copy from the backend. |
| L12 | `SequenceEditorModal.tsx` | The sequence editor fetches `GET /strategy` just for the safety list; a user without `AUTOMATION_READ` silently sees none. | A small `/outreach/safety-rules` endpoint, or ship the list with the sequences payload. |
| L13 | `telnyx.dto.ts`, `sequence.dto.ts` `onlyIf` | Only `@IsObject`; unknown keys inside rules are stored, value arrays are unbounded. | A nested DTO for `OnlyIf`/`ConditionRule`, or run `onlyIfError` plus a whitelist in a pipe. |
| L14 (unsure) | `lead-watcher.service.ts` | With two instances up at once (a rolling deploy) both can resume the same in-flight lead. The step record (H1) now stops a second dial of the same step, but both would schedule timers. Pre-existing; whether production deploys roll is not known. | A per-lead lease (e.g. `leads.engine_owner` + heartbeat) or a Redis lock in `resume`. |
| L1 (older endpoints) | `portal.controller.ts` `enroll`, `status`, `outcome`, `qualified` | Still scoped to the organization only, not `visibleLeads`; an agent with `LEAD_UPDATE` but without `LEAD_READ` can act on an unassigned lead by id. Only the two new quick-action endpoints were fixed. | Apply the same `visible()` check. |
| AMD (unsure) | §3.7 | Premium AMD alongside `ai_assistant_start` on the same call is untested live; the `speak` voice (`female`, basic) is a guess at the cheapest working value. | Try one real call per path (human / machine + hang up / machine + message) on the Telnyx account. |

**Basic vs premium answering machine detection** (for the owner's decision; from the Telnyx docs and pricing on 2026-10-27)

| | Basic (`detect`, `detect_beep`, `detect_words`, `greeting_end`) | Premium (`premium`) |
|---|---|---|
| Method | Audio heuristics (silence, word count, beep). | Speech recognition + machine learning; Telnyx's recommended mode. |
| Results | `human`, `machine`, `not_sure` (`call.machine.detection.ended`). | `human_residence`, `human_business`, `machine`, `silence`, `fax_detected`, `not_sure` (`call.machine.premium.detection.ended`). |
| Beep for leaving a message | `detect_beep` / `detect_words` send `call.machine.greeting.ended` with `beep_detected`, or `not_sure` after 30s. | `call.machine.premium.greeting.ended` with `beep_detected` / `no_beep_detected`. |
| Price (per call) | $0.002 | $0.0065 |
| Accuracy | Not quantified in the docs. | Not quantified in the docs ("exceptional accuracy"). |
| Unsure | Whether basic mode's beep detection is reliable enough for the voicemail message; no public accuracy numbers for either. | Same; and whether it interacts with the assistant's audio. |

The code uses `premium`; switching to a basic mode is one string in `voice.service.ts` plus the `call.machine.greeting.ended` route already in the webhook controller.

**Other known limits** (unchanged): the analysis wait holds a picked-up unscored call's next step up to 15 min; voicemail with detection off and no analysis counts as answered after 30s of "talk"; bookings are seen only once the calendar sync records them (`CALENDAR_WEBHOOK_BASE_URL`; Calendly free plan has no webhooks); leads in the strategy before deploy have no step runs; Telnyx's natural-language SMS opt-out pauses automation but does not set `dnc_status`; sequences keep their old timing (from the previous step's firing, not a call's end).

---

## 7. After the Retell merge (`feature/retell-provider`, 9880ef4, pushed)

- **SMS skip reason.** Re-add `sms_unavailable` to `SkipReason` and `SKIP_LABELS`; record it when the provider has no SMS, in the engine and the runner.
- **Retell analysis.** Map `call_analysis.in_voicemail` to `reached_person`; map `user_requested_dnc` / `do_not_contact` the same way.
- **Retell dead numbers.** Fold `invalid_destination` into `endReasonOf` / dead-number handling.
- **Retell busy and voicemail.** `dial_busy` and `voicemail_reached` are in `BUSY_REASONS` / `VOICEMAIL_REASONS`; make sure the Retell webhook writes them to `calls.end_reason`. Retell calls get no Telnyx AMD; the voicemail setting applies to Telnyx only.
- **Editor.** Pass `smsUnavailableReason` to `StrategyEditor` for Retell orgs.
- **Expected small conflicts:** `engine.service.ts` (constructor, the SMS send in `run`), `followup.runner.ts` (`fire`), `portal.controller.ts` (the lead flow), `activity.service.ts` (`onCallAnswered`, `onCallHangup`, the provider param), `call.worker.ts` (the dial call + A4), `voice.service.ts` (constructor).

---

## 8. Deploy checklist

- [ ] `npx prisma migrate deploy` (two additive migrations; nothing new in this commit).
- [ ] Stop the backend, run `npx prisma generate`, then start it.
- [ ] `CONDITIONAL_OUTREACH_ENABLED` stays **unset/0** for the first deploy: nothing changes for any org. Set it to `1` and restart to switch the engine, the runner, the strategy editor and the sequence editor to the new behaviour, for every org at once.
- [ ] "Detect voicemail": no org changes on deploy. An org with its assistant-level detection on keeps it and sees it on; one without sees it off. Call-level premium AMD ($0.0065 per call on their Telnyx account) starts only once an owner changes the setting in AI Settings, and that is when their assistant-level detection is switched off.
- [ ] Set `CALENDAR_WEBHOOK_BASE_URL` in the production backend `.env` (bookings found only by the 5-minute poll without it).
- [ ] Watch the leads list for `STEP_FAILED_REVIEW` flags in the first days: they mean a step kept throwing (database / Redis).
- [ ] Tell owners: an older strategy keeps running as it is until they open and save it in the new two-step form (flag on).

---

## 9. Tests

**Baseline vs current**

| Suite | master aaf9e84 (before the feature) | a237ab4 (feature, reviewed) | 1033ac2 (review fixes) | This commit (voicemail: assistant-level stands) |
|---|---|---|---|---|
| Backend unit | 25/25 | 258/258 | 295/295 | **301/301** |
| `conditional-outreach.int.ts` | — | 30/30 (one run hit a network blip on 2 tests; both passed on rerun) | 36/36 | **36/36** |
| `outreach-schedule.int.ts` | 21/21 | 21/21 | 21/21 | **21/21** |
| Backend tsc (tracked files) | clean | clean | clean | **clean** |
| Frontend unit | 105/110 (5 strays) | 125/130 (5 strays) | 130/135 (5 strays) | **130/135** (5 strays) |
| Frontend tsc | 2 errors (strays) | 2 errors (strays) | 2 errors (strays) | 2 errors (strays) |
| Frontend build | ok | ok | ok | **ok** |

The strays are untracked files listed in `.git/info/exclude`: `backend/src/modules/*.test.ts` (91 tsc errors) and `frontend/src/components/**/{LeadsView,LeadDetailModal,…}.spec.tsx` (the 5 frontend failures and the 2 tsc errors). They come from another lineage; leave them.

**Existing test expectations that changed on purpose in this commit**
- `engine-steps.spec.ts` / `engine-safety.spec.ts`: the call dedupe key now ends in the step number (`:2` for the default's second step), keyed by `first_contact_at`.
- `engine-two-step.spec.ts`: the restart test reads `guard.stepRuns` instead of `guard.lastRunAt`.
- `strategy-store.spec.ts`: `toTwoStep` keeps the first step's own start (`early` at 2 min, not 0).
- `activity-calls.spec.ts`: rewritten for the one-way row moves (`updateMany` on answer, one raw `UPDATE … RETURNING` on hang-up).
- `voice-amd.spec.ts`: AMD is asked for only with the setting on.
- Constructors: `EngineService`, `StrategyStoreService`, `VoiceService`, `AssistantService`, `LeadAutomationController` take one more dependency.

**Spec map (additions in bold)**

| Area | Specs |
|---|---|
| Characterization of the old behaviour (flag off) | `telnyx/engine-steps.spec.ts`, `followup/followup-runner-steps.spec.ts`, `telnyx/activity-calls.spec.ts`, **the "with conditional outreach off" describes in `engine-steps`, `strategy-store`, `followup-runner-safety`** |
| Safety rules and guard | `telnyx/engine-safety.spec.ts`, `followup/followup-runner-safety.spec.ts`, `outreach/step-guard.spec.ts` (**+ queue timeout, `stepRuns`**), `outreach/safety-rules.spec.ts` |
| Two-step strategy and redesign | `telnyx/engine-two-step.spec.ts`, `telnyx/engine-redesign.spec.ts`, `telnyx/strategy-store.spec.ts` (**+ 12h caps, step-1 start kept**), `outreach/conditions.spec.ts`, `outreach/schedule-two-step.spec.ts`, `outreach/strategy-flow.spec.ts` |
| **Recovery and resume** | **`telnyx/engine-recovery.spec.ts`**: retry with backoff, give-up with the flag, a failed enrol stays claimed, the lead re-checked before a send (reply / booking / opt-out), resume from the step record (pause/resume and restart with a queued call), stable call key, a 30-day timer |
| **Watcher, quick actions** | **`telnyx/lead-watcher.service.spec.ts`**, **`telnyx/lead-automation.controller.spec.ts`** (the real `PermissionsGuard` on both handlers, the lead scope) |
| Audit fixes | `telnyx/lead-scoring-outcomes.spec.ts`, `telnyx/lead-scoring-reached.spec.ts`, `telnyx/engine-booking.spec.ts`, `calendar/booking/in-call-booking-booked.spec.ts`, `telnyx/inbound-sms-keywords.spec.ts`, `telnyx/voice-amd.spec.ts` (**rewritten**), `telnyx/calls/call.worker.spec.ts`, `followup/followup-hot-trigger.spec.ts`, `telnyx/lead-insights-provision.spec.ts` |
| **Voicemail detection** | **`telnyx/activity-calls.spec.ts` "answering machine detection"** (not sure = human; hang up; leave message with variables; beep before verdict; no beep), `voice-amd.spec.ts`, **`telnyx/assistant-voicemail.spec.ts`** (assistant-level value is the starting value; an unrelated save or the form resent changes nothing; only the owner's change saves the setting and switches the assistant's detection off), the int test |
| Real DB | `outreach/conditional-outreach.int.ts` (**+ "review fixes" describe: H1 pause/resume and restart with a queued call, end to end through `TelnyxWebhookController` with a repeated hang-up, M1 race, L1 agent scope, voicemail timing**) |
| Frontend | `utils/strategiesApi.spec.ts` (**+ step-2 cap**), `utils/conditions.spec.ts`, **`components/views/StrategyEditor.spec.tsx`** |

**Integration-suite rules**
- Every test makes its own org and deletes it.
- Test phones are unique per run (`phoneSeq`), because texts are matched by phone.
- Wait on step-run rows, not on texts: the fake SMS records before the row is written.
- Keep a live call shorter than the next step's first check, because a held step looks again only after `RECHECK_MS` (60s).
- The suite's `activity` has no Telnyx account (`getCreds` → null): webhooks need no signature and nothing is attached to a call.
