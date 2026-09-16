#!/usr/bin/env bash
# End-to-end check of the ingest HTTP contract against a running API.
#
# Every assertion here maps to a row in the status-code table in the plan. The
# ones that matter most are the DUPLICATE case (a non-2xx there makes Tally
# retry for a day and create duplicate leads) and the signature cases.
#
# Usage: ./scripts/test-ingest.sh <ingest-token> <signing-secret> [base-url]
set -uo pipefail

TOKEN="${1:?usage: test-ingest.sh <token> <secret> [base]}"
SECRET="${2:?usage: test-ingest.sh <token> <secret> [base]}"
BASE="${3:-http://localhost:3001}"
URL="$BASE/ingest/v1/tally/$TOKEN"

pass=0; fail=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m  %-44s %s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  \033[31mFAIL\033[0m  %-44s expected %s, got %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

sign() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64; }
post() { # post <body> <signature-header-or-empty>
  if [ -z "$2" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'Content-Type: application/json' -d "$1"
  else
    curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H 'Content-Type: application/json' \
      -H "Tally-Signature: $2" -d "$1"
  fi
}

EVENT_ID="evt_$(date +%s)_$RANDOM"
BODY=$(cat <<JSON
{"eventId":"$EVENT_ID","eventType":"FORM_RESPONSE","createdAt":"2026-09-15T10:00:00.000Z","data":{"responseId":"resp_$RANDOM","submissionId":"sub_1","respondentId":"rsp_1","formId":"form_1","formName":"Buyer Inquiry","fields":[{"key":"question_1","label":"Your name","type":"INPUT_TEXT","value":"Brandon Hayes"},{"key":"question_2","label":"Email","type":"INPUT_EMAIL","value":"b.hayes@example.com"},{"key":"question_3","label":"Best number","type":"INPUT_PHONE_NUMBER","value":"+15125550291"},{"key":"question_4","label":"Timeline?","type":"MULTIPLE_CHOICE","value":["opt_a"],"options":[{"id":"opt_a","text":"ASAP / under 30 days"},{"id":"opt_b","text":"1-3 months"}]}]}}
JSON
)

echo
echo "Ingest contract -> $URL"
echo

check "valid signature accepted"            202 "$(post "$BODY" "$(sign "$BODY")")"
# The critical one: Tally's retry of something we already hold must be a silent
# 200. A 4xx/5xx here triggers the full 5m/30m/1h/6h/1d ladder and then emails
# the form owner that our webhook is broken.
check "duplicate eventId -> silent 200"     200 "$(post "$BODY" "$(sign "$BODY")")"
# Must be a FRESH eventId: replaying a known eventId with a bad signature is
# correctly treated as a duplicate (we already hold that delivery) and short-
# circuits to 200 before signature state can matter.
BAD_BODY="${BODY/$EVENT_ID/${EVENT_ID}_tampered}"
check "tampered signature quarantined"      401 "$(post "$BAD_BODY" "$(sign 'wrong-body')")"
check "unsigned accepted (require=false)"   202 "$(post "${BODY/$EVENT_ID/${EVENT_ID}_b}" "")"
check "malformed JSON -> 400"               400 "$(post '{"broken":' "")"
check "empty body -> 400"                   400 "$(post '' '')"
check "unknown token -> 404"                404 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        "$BASE/ingest/v1/tally/whk_live_AAAAAAAAAAAAAAAAAAAA" -H 'Content-Type: application/json' -d '{}')"
check "malformed token -> 404"              404 "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        "$BASE/ingest/v1/tally/garbage" -H 'Content-Type: application/json' -d '{}')"

echo
echo "  $pass passed, $fail failed"
echo
[ "$fail" -eq 0 ]
