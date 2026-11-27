/**
 * Where the landing page's video assets live. They are generated from the full
 * demo recording by `frontend/scripts/make-clips.sh` (see `clips.json`), and
 * served as static files from `frontend/public/videos/`.
 *
 * Every clip is optional at runtime: if a file is missing, ClipVideo shows a
 * styled placeholder instead of a broken player, so the page can ship before
 * the clips are cut.
 */

export type ClipName =
  | 'hero'
  | 'intake'
  | 'ai-call'
  | 'conversations'
  | 'followups'
  | 'scheduling'
  | 'routing';

const CLIP_BASE = '/videos/clips';

export const clipSources = (name: ClipName) => ({
  webm: `${CLIP_BASE}/${name}.webm`,
  mp4: `${CLIP_BASE}/${name}.mp4`,
  poster: `${CLIP_BASE}/${name}.jpg`,
});

