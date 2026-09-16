# Testing a real Tally form end to end

Goal: create a webhook URL in the UI, paste it into your own Tally form, submit
it, and watch the parsed answers appear.

You need three things running: the **API**, a **public tunnel** (Tally cannot
reach `localhost`), and the **frontend**.

---

## 1. Point the backend at a public URL

Tally calls your webhook from their servers, so the URL you give them has to be
reachable from the internet. `http://localhost:4000` is not. You need a tunnel.

**cloudflared** is the easiest — quick tunnels need no account:

```bash
brew install cloudflared          # or: https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:4000
```

It prints something like `https://random-words-here.trycloudflare.com`.

**ngrok** works too (free account required for a stable URL):

```bash
brew install ngrok && ngrok config add-authtoken <your-token>
ngrok http 4000
```

Then set that URL in `backend/.env` so the webhook URLs we generate point at the
tunnel rather than at localhost:

```bash
PUBLIC_API_BASE_URL="https://random-words-here.trycloudflare.com"
```

> Restart the API after changing this. The URL is baked into each lead source's
> displayed webhook URL at read time, so existing sources pick up the new host
> automatically — you do **not** need to recreate them. The token itself never
> changes.

---

## 2. Start the backend

```bash
cd backend
npm run dev          # watch mode, or `npm run build && npm start`
```

One process serves the portal and the ingestion routes on :4000.

Check it: `curl http://localhost:4000/api/v1/health` → `{"status":"ok","database":"ok",...}`

---

## 3. Start the frontend

The browser holds no API key. It signs in, and the backend reads the
organization off that session token — so there is nothing to paste into a
frontend `.env`.

```bash
cd frontend
npm run dev          # :3000
```

Open http://localhost:3000, sign up or log in, and click **Lead Sources** in the
sidebar (it has a green `LIVE` badge — most other screens still show in-browser
demo data).

> The first request for an organization mints its ingestion API key
> automatically and stores it encrypted. You never see or handle it.

---

## 4. Create the source and connect Tally

1. Click **New lead source**, name it, **Create & show secret**.
2. You'll see a **Webhook URL** and a **Signing secret**, each with a copy
   button. The signing secret is shown **once** — it's encrypted at rest and no
   API response returns it again. (The webhook URL is always recoverable.)
3. In Tally: open your form → **Integrations** → **Webhooks** → **Add webhook**
   - paste the **Webhook URL**
   - expand **Signing secret** and paste the secret
   - **Connect**
4. Submit a response to your form.

The Deliveries panel polls every 4 seconds, so it should appear on its own
within a few seconds.

---

## What you should see

Each delivery shows every question and answer as Tally sent it:

```
15/09/2026, 6:04:11 pm   [verified]  [Buyer Inquiry]          681B
  Your name         Brandon Hayes                    INPUT_TEXT
  Email             b.hayes@example.com              INPUT_EMAIL
  Best number       +15125550291                     INPUT_PHONE_NUMBER
  Timeline?         ASAP / under 30 days             MULTIPLE_CHOICE
```

Two things worth checking, because they're the ones that silently go wrong:

- **Dropdown / multiple-choice answers must read as text**, e.g.
  `ASAP / under 30 days`. Tally sends those as option UUIDs (`opt_a`) with the
  text in a sibling array; if you ever see a raw id here, option resolution
  broke.
- **The signature pill should read `verified`** (green). `unsigned` means you
  didn't paste the secret into Tally. `bad signature` (red) means the secret
  doesn't match.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Can't reach the API" in the UI | The backend isn't running | Start it on :4000 |
| 401 from the UI on every Lead Sources call | The session expired, or you are not logged in | Sign in again — the session token is what identifies the org |
| Nothing arrives after submitting | The webhook URL points at `localhost`, so Tally can't call it | Set `PUBLIC_API_BASE_URL` in `backend/.env` to your tunnel URL and restart |
| Red **bad signature** card | The secret in Tally doesn't match ours | Nothing is lost — the raw payload is retained and can be re-verified once the secret is corrected |
| Grey **unsigned** pill | No secret pasted into Tally | Add it, or leave it: signature is verified-when-present by default, not required |
| Tally's own test shows a failure | Tally requires a 2xx within 10 seconds | Check the API log; a cold start on a free tunnel can exceed this on the very first request |

---

## Current limitation — read this

Deliveries are **received, verified and durably stored**, and this screen shows
you the parsed answers. But they are **not yet turned into Lead rows** — every
row sits at `queue_state = PENDING` with nothing consuming it.

The worker, field-mapping engine and dedupe/merge logic are the next chunk of
work. So this test confirms *"is my data arriving, complete and correctly
parsed?"* — which is exactly the question worth answering before building the
mapping layer on top of it.

Nothing is lost in the meantime: the raw body of every delivery is retained, so
once mapping exists these submissions can be replayed into real leads.
