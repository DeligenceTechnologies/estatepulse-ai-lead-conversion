# Lead Manual Edit — Plan

> Abhi kisi lead ko haath se edit karne ka koi option nahi hai, na backend mein na frontend mein.
> `manual-lead.service.ts` mein ye jaan-boojh kar likha hai: _"an imported one is corrected where it came from and synced again"_.
> Ye plan batata hai ki edit **kahan** lagana hai aur **kaise** kaam karna chahiye.

---

## 1. Kya edit ho sakta hai, kya nahi

| ✅ Edit form mein | ❌ Edit form mein NAHI (inke apne flow hain) |
|---|---|
| First name, Last name | Status → `PATCH /portal/:id/status` |
| Phone, Email | Temperature, Score → AI scoring |
| Location, Timeline | Consent → Consent Review |
| Min / Max budget, Bedrooms | DNC → opt-out flow |
| Financing status | Assigned agent → `PUT /:id/assignment` |
| Notes (`motivation`) | Time zone → `PUT /:id/timezone` |
| | `aiSummary`, `memorySummary` |

Status, consent ya DNC ko edit form mein daalne se audit aur compliance bypass ho jayega.

---

## 2. Backend — `PATCH /v1/leads/:leadId`

**Files:**
- `backend/src/lead/dto/update-lead.dto.ts`: naya DTO. `CreateLeadDto` ke fields lo, sab optional karo, `consent` aur `startOutreach` hata do, aur `financingStatus` jodo. Kisi field ko clear karne ke liye `null` bhejna allowed ho.
- `backend/src/lead/lead-edit.service.ts`: naya service.
- `backend/src/lead/leads.controller.ts`: route jodo.

```ts
@Patch(':leadId')
@RequirePermissions(PERMISSIONS.LEAD_UPDATE)
update(@CurrentAuth() auth, @Param('leadId', ParseUUIDPipe) leadId, @Body() body: UpdateLeadDto) {
  return this.leadEdits.update(auth, leadId, body);
}
```

**Service ka flow:**

1. **Lead dhoondho:** `where: { id, ...visibleLeads(auth) }` lagao. Isse assigned-only agent sirf apni leads edit kar payega. Lead na mile to `NOT_FOUND`.
2. **Validate karo:**
   - phone ya email mein se kam se kam ek bacha rahe
   - `minBudget <= maxBudget`, jo values pehle se save hain unke saath mila kar
3. **Phone badla ho to:**
   - `parsePhoneNumberFromString` se parse karo. Valid na ho to error do ("Start with the country code…").
   - `normalizedPhone` aur `phoneValid` update karo.
   - Agar `reviewReasons` mein `PHONE_UNPARSED_REASON` tha, to use hata do.
4. **Email badla ho to:** `normalizedEmail` aur `emailValid` update karo.
5. **DNC check dobara chalao:** naya phone `ContactSuppression` mein ho, ya kisi DNC lead ka phone/email ho, to `dncStatus=true` aur `automationPaused=true` set karo.
6. **Ek hi transaction mein:**
   - `lead.update(...)`
   - `audit.record({ action: 'lead.updated', payload: { changed: { field: [old, new] } } })`
7. **Transaction ke baad:**
   - `LeadStateService.quietly({ type: 'lead_edited', source: 'agent', … })` taaki Activity timeline mein dikhe
   - phone badla ho to queue mein pade calls aur texts jagao, kyunki time zone phone se nikalta hai. `LeadTimezoneService.wake()` ko reusable bana kar use karo.
   - `events.publish({ type: 'lead.updated' })` taaki list refresh ho
8. **Return:** updated row, usi shape mein jo `toLeadRow` deta hai.

**Sync se takraav:**
- **HubSpot:** `crm-sync.service.ts` three-way merge karta hai, to manual edit ko local change maan ke conflict flag karega, chupchap overwrite nahi karega. Ye theek hai.
- **Google Sheets / File import:** inka behaviour verify nahi hua. Implement karne se pehle check karo ki dobara sync karne par edit overwrite hota hai ya nahi.
- **Webhook:** har submission nayi lead banata hai, to koi takraav nahi.
- **AI calls:** budget aur location ke columns sirf padhte hain, overwrite nahi karte.

---

## 3. Frontend — Edit button kahan lagane hain

| # | Jagah | File | Kya lagana hai | Priority |
|---|---|---|---|---|
| 1 | Lead detail header, Quick Actions (Assign ke paas) | `components/modals/LeadDetailModal.tsx` (~line 340) | **"Edit lead"** button, jo pura form khole | P0 |
| 2 | Review banner, jab reason galat phone ka ho | `LeadDetailModal.tsx` (~line 487) | **"Fix phone"** button, "Approve" ke saath | P0 |
| 3 | Time zone card, jab "No phone number" dikhe | `LeadDetailModal.tsx` (~line 530) | **"Add phone"** link. Abhi UI kehta hai "Add a phone number first" lekin add karne ki jagah hai hi nahi | P0 |
| 4 | Overview field cards (Budget, Location, Timeline, Bedrooms, Financing) | `LeadDetailModal.tsx` (~line 469) | Har card pe ✏️ pencil, wahin inline edit | P1 |
| 5 | Leads table, row actions (Call ke paas) | `components/views/LeadsView.tsx` (~line 797) | ✏️ icon jo seedha edit form khole | P1 |
| 6 | Agent ka lead modal | `components/agent/AgentLeads.tsx` | #1 jaisa button, sirf assigned leads ke liye | P1 |
| 7 | Built-in qualification answers | `components/leads/LeadQualificationMemory.tsx` | Custom answers jaisa edit, built-in sawalon (budget/timeline/location) ke liye bhi, isi PATCH se | P2 |

**Form:** naya form banane ke bajaye `NewLeadModal.tsx` ko `mode="edit"` aur `initial={lead}` dekar reuse karo:
- consent aur start-outreach checkbox edit mode mein chhupa do
- title "Edit lead" aur button "Save changes" rakho
- sirf badle hue fields bhejo
- save ke baad modal aur list dono refresh karo

**API helper:** `updateLead(leadId, patch)` jodo, wahi helper file mein jahan `createLead` hai.

---

## 4. Order of work

1. Backend PATCH: DTO, service, route
2. Frontend: `NewLeadModal` edit mode + header button (#1)
3. Phone fix buttons (#2, #3)
4. Inline pencil, table action, agent modal (#4, #5, #6)
5. Built-in qualification edit (#7)

## 5. Check karne wali cheezein (manual testing)

- [ ] Phone ko DNC number se badlo → lead DNC aur paused ho jaye
- [ ] Galat phone theek karo → "phone unparsed" review reason hat jaye
- [ ] Phone aur email dono khali karo → error aaye
- [ ] Assigned-only agent dusre ki lead edit kare → 404 aaye
- [ ] Edit ke baad Activity timeline mein `lead_edited` event dikhe, purani aur nayi value ke saath
- [ ] HubSpot lead edit karke sync karo → conflict flag ho, overwrite na ho
- [ ] Google Sheet ki lead edit karke dobara sync karo → dekho edit bacha ya overwrite hua
