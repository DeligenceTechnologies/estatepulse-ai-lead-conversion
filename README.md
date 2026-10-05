# EstatePulse AI — Lead Conversion System

A frontend prototype/demo of the AI Real Estate Lead Conversion Platform described in
the product requirements doc, built around a fictional brokerage ("Austin Home
Advisors") matching PRD Section 61's recommended demo scenario.

This is a **client-only demo**: all "backend" behavior (AI qualification, voice
calls, SMS, scoring, CRM sync, n8n workflows) is simulated in the browser via
`src/context/AppContext.tsx`, with state persisted to `localStorage`. There is no
server, database, or real integration wired up yet — no API keys are required to
run it. See `.env.example` for the real integrations (Supabase, Retell, Twilio,
Calendly, Follow Up Boss, n8n) this UI would connect to in a production build.

## What's implemented

- Dashboard, Lead Pipeline, Conversations, Voice Calls, Appointments, Follow-Up
  Sequences, Agent Team, Integrations, AI Prompt & Tone settings, Analytics/ROI
- Lead detail view with deterministic score breakdown (PRD Section 26)
- Agent Pre-Call Briefing screen (PRD Section 41)
- Live AI voice call simulator with real-time structured data extraction
- Webhook payload tester (`POST /api/webhooks/leads` simulation, PRD Section 66)
- Public marketing landing page + live demo lead capture form (PRD Section 59-61)
- PDF report export (`src/utils/pdfExport.ts`)

## Run locally

**Prerequisites:** Node.js 18+

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Other scripts:

```bash
npm run build    # production build to dist/
npm run preview  # preview the production build
npm run lint      # TypeScript type-check (tsc --noEmit)
