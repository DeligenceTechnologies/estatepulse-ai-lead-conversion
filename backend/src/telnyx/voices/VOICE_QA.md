# Voice catalog test checklist

A voice goes into `voice-catalog.ts` only after it passes all three checks
below on a test organization. The goal is that a lead hears the same voice
on a live call, in a voicemail and in a transfer prompt.

## For each voice

1. **Live call**: pick the voice in AI Settings, save, then place a real
   outbound call to a test phone. Listen to the greeting and a few turns.
   It should sound natural, the pace should be right, and names and
   addresses should be pronounced well.
2. **Voicemail**: call a phone that sends you to voicemail. In the backend
   logs, check that there is **no** `voicemail fell back` warning; that
   warning means Telnyx `speak` refused the voice. Play the voicemail back
   and confirm it is the same voice as on the live call.
3. **Transfer**: start a transfer that no agent picks up. The hold and
   announcement lines should be in the same voice, with no fallback warning.
4. **Sample**: press play on the card. The server makes the clip once with
   Telnyx TTS (`POST /v2/text-to-speech/speech`, English line, `language`
   set) and caches it. Check that it sounds like the live call.

## Results

| key      | Telnyx voice id             | live | voicemail | transfer | preview | tested by / date |
|----------|-----------------------------|------|-----------|----------|---------|------------------|
| brian    | Telnyx.Bayan.Brian          |      |           |          |         |                  |
| arjun    | Telnyx.Bayan.Arjun          |      |           |          |         |                  |
| danielle | aws.Polly.Danielle-Neural   |      |           |          |         |                  |
| gregory  | aws.Polly.Gregory-Neural    |      |           |          |         |                  |
| heart    | Telnyx.KokoroTTS.af_heart   |      |           |          |         |                  |
| adam     | Telnyx.KokoroTTS.am_adam    |      |           |          |         |                  |
| emma     | Telnyx.KokoroTTS.bf_emma    |      |           |          |         |                  |

Voices Telnyx doesn't list are left off the cards automatically, and the
backend logs `preferred voice … is not in Telnyx's English voice list`. The
gap is then filled from Telnyx's other English voices. Those still need this
checklist before you rely on them.

Remove any voice that fails a check, or swap in another candidate. Keep the
list at 6–8 voices.
