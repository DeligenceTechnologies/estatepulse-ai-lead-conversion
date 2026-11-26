#!/usr/bin/env bash
# Cuts the landing page's product clips out of the full demo recording.
#
#   1. Put the recording in frontend/public/videos/source/ (gitignored) and
#      point "source" in scripts/clips.json at it.
#   2. Each clip has either "start"/"end", or "segments": [[start, end], ...]
#      which are joined into one montage (used for the hero).
#   3. From frontend/:  bash scripts/make-clips.sh
#
# Outputs (served by Vite from public/):
#   public/videos/clips/<name>.webm  muted VP9, 1280px wide   (preferred by browsers)
#   public/videos/clips/<name>.mp4   muted H.264, 1280px wide (Safari / fallback)
#   public/videos/clips/<name>.jpg   poster frame
#   public/videos/demo-full.mp4      the whole walkthrough, 1080p, with audio
#
# Needs ffmpeg and jq:  brew install ffmpeg jq
# Flags: --skip-full  only re-cut the short clips
#        --only NAME  only cut one clip
set -euo pipefail

cd "$(dirname "$0")/.."
MANIFEST=scripts/clips.json
SRC=$(jq -r '.source' "$MANIFEST")
OUT=public/videos/clips
SKIP_FULL=0
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-full) SKIP_FULL=1 ;;
    --only) ONLY="$2"; SKIP_FULL=1; shift ;;
  esac
  shift
done

for bin in ffmpeg jq; do
  command -v "$bin" >/dev/null || { echo "Missing $bin — run: brew install ffmpeg jq" >&2; exit 1; }
done
[[ -f "$SRC" ]] || { echo "Source video not found: $SRC" >&2; exit 1; }
mkdir -p "$OUT"

SCALE="scale=1280:-2:flags=lanczos,fps=30"

# Writes a silent, scaled intermediate for one clip to $1 (lossless-ish, re-encoded below).
cut_clip() {
  local clip="$1" dest="$2"
  if jq -e '.segments' <<<"$clip" >/dev/null; then
    local inputs=() filter="" n=0
    while read -r seg; do
      inputs+=(-ss "$(jq -r '.[0]' <<<"$seg")" -to "$(jq -r '.[1]' <<<"$seg")" -i "$SRC")
      filter+="[$n:v]$SCALE,setpts=PTS-STARTPTS[v$n];"
      n=$((n + 1))
    done < <(jq -c '.segments[]' <<<"$clip")
    local labels=""
    for ((i = 0; i < n; i++)); do labels+="[v$i]"; done
    filter+="${labels}concat=n=$n:v=1:a=0[out]"
    ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "$filter" -map "[out]" \
      -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p "$dest" </dev/null
  else
    ffmpeg -loglevel error -y -ss "$(jq -r '.start' <<<"$clip")" -to "$(jq -r '.end' <<<"$clip")" \
      -i "$SRC" -an -vf "$SCALE" -c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p "$dest" </dev/null
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

jq -c '.clips[]' "$MANIFEST" | while read -r clip; do
  name=$(jq -r '.name' <<<"$clip")
  [[ -n "$ONLY" && "$name" != "$ONLY" ]] && continue
  echo "→ $name"

  cut_clip "$clip" "$TMP/$name.mp4"

  ffmpeg -loglevel error -y -i "$TMP/$name.mp4" -an \
    -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart \
    "$OUT/$name.mp4" </dev/null

  ffmpeg -loglevel error -y -i "$TMP/$name.mp4" -an \
    -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -deadline good \
    "$OUT/$name.webm" </dev/null

  # Poster: the first frame of the clip, so it matches what plays.
  ffmpeg -loglevel error -y -i "$OUT/$name.mp4" -frames:v 1 -q:v 3 "$OUT/$name.jpg" </dev/null

  du -h "$OUT/$name.mp4" "$OUT/$name.webm" | sed 's/^/   /'
done

if [[ $SKIP_FULL -eq 0 ]]; then
  echo "→ demo-full (1080p, with audio)"
  ffmpeg -loglevel error -y -i "$SRC" -vf "scale=-2:'min(1080,ih)':flags=lanczos" \
    -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -movflags +faststart \
    public/videos/demo-full.mp4 </dev/null
  du -h public/videos/demo-full.mp4 | sed 's/^/   /'
fi

echo "Done."
