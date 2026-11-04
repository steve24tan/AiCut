# Verification — 2026-11-03

Environment: Windows, Node.js 24.20.0, bundled SQLite 3.53.4, installed Chrome headless. Only temporary synthetic fixtures were used. No production project or media was imported.

## Passed

`npm.cmd test`: 7/7 integration checks.

- Prompt, notes, active take and immutable historical snapshot persisted across a complete server/database restart.
- Stale revision writes and stale uploads returned HTTP 409; the current draft remained intact.
- Ordering accepted the complete project set and rejected missing/duplicate IDs.
- Media returned byte ranges, suffix ranges, HEAD lengths and HTTP 416 for out-of-bounds ranges.
- Online database snapshot plus media copy reopened correctly, including referenced media bytes.
- Foreign Origin, missing local header, invalid fields and unsupported file extensions were rejected; private source files were not served.
- Text-only segments saved snapshots with no external AI or media service.

`node scripts/browser-smoke.mjs`: passed using installed Chrome, isolated temporary data and a separate browser profile.

- Created a project and three shots through the interface.
- Entered Prompt, notes and statuses; waited for autosave and checked database contents.
- Imported an actual PNG through the file input and inspected its version snapshot.
- Confirmed clipboard-permission fallback contains the correct shot context.
- Generated a tiny WebM locally using browser canvas/MediaRecorder, imported it as v2 and verified muted playback advanced the video time.
- Reloaded the page and verified notes, versions and video preview remained available.
- Captured desktop screenshot at `test-results/browser-smoke.png` and inspected layout.
- Checked mobile viewport width for horizontal overflow; no browser runtime exceptions.

## Test environment findings

Browser automation requires an environment that allows Chrome child processes and local debugging connections. Automated playback uses muted video to respect Chrome autoplay rules. The browser test waits for page reload before checking restored controls.

## Remaining verification

- Real user media, long videos, codec variations, 1 GB imports, disk-full conditions and power-loss recovery are not benchmarked.
- No claim that MOV or every MP4 codec can play in every browser.
- No automatic scene detection, encoded clip cutting, side-by-side comparison or folder watcher is implemented.
- No hosted site, model API or subscription automation exists.
- Test servers shut down after validation. Start the real workspace with `start.cmd`; its data starts empty.
- The initial release passed GitHub Actions on Node 24 for Windows and Linux. Subsequent commit results appear in GitHub Actions.

## v0.8 micro-motion — 2026-11-04

`npm.cmd test`: 47/47. `motion.test.mjs` covers rig normalization (unknown fields dropped), rejection of non-image or foreign source takes, loop length, effect, box, strength/speed/feather/pivot ranges and more than 8 regions (no change on failure), stale revision, clearing, and v6→v7 migration with a snapshot.

`node scripts/motion-browser-qa.mjs` (headless Chrome, SwiftShader WebGL, synthetic 540×960 still): exact-pixel readback shows 0 changed pixels outside the box versus the source, the boxed area moves between phases, and loop start/end frames match; real mouse box, effect switch to sway, pivot picked by click, save, export, reopen editing the still, mobile width, no runtime exceptions. Export: first real-time MediaRecorder attempts produced 0.28 s / 2.95 s clips for a 2 s loop (recording starts ~1.2 s late and software WebGL renders ~10 fps), so export was changed to offline WebCodecs H.264 + a hand-written MP4 muxer; ffmpeg decodes the result as 60 frames, 2.00 s, 540×960 @ 30 fps with no errors. All earlier browser QA and the 剪映 export QA still pass.

Not verified: real GA stills and GPU browsers on the GA PC, how the motion looks on chibi art, importing the exported MP4 into 剪映 (standard H.264 Baseline MP4, expected to work).

## v0.7 audio timeline, dialogue, agent tasks, 剪映 export — 2026-11-04

`npm.cmd test`: 45/45. New suites: `audio.test.mjs` (uploads and library-asset clips, rejected uploads leave no files, clip edit validation, cross-project moves blocked, versions for A/B keep the trim window, stale revisions, duration reported once, audio regions, cascade delete keeps media, timeline manifest, backup, v5→v6 migration snapshot), `voices.test.mjs` (characters, dialogue saved atomically with the shot revision, voice changes block stale adoption, in-use characters cannot be deleted), `tasks.test.mjs` (real herdr adapter against a stand-in CLI: discovery, stopped server, busy/blocked agents refused and recorded as failed, one-line pointer; full agent round trip through real `cli.mjs` subprocesses: claim → `audio version` → complete; voice/music/mix validation and `audio add`; prompt jobs via herdr).

`node scripts/timeline-browser-qa.mjs` (headless Chrome, synthetic PNG/WebM/WAV, stand-in herdr): video track layout with probed duration, audio track creation, WAV upload with waveform and duration report, mouse drag move, edge trim, time-range boxes with autosaved notes, an agent-imported v2 picked up by polling, A/B audition, timeline playback, copy text, push to herdr agent, Shift multi-select mix task, BGM generation dialog, task list, per-shot dubbing task, characters dialog and dialogue lines, cross-track move, remove, mobile width, no runtime exceptions. Bugs found and fixed during QA: a version-ownership query missing a parameter; quick successive character edits sending a stale revision; Shift multi-select ignored in time-box mode; migration robustness when the jobs.target column already exists. `browser-smoke.mjs` and `regions-browser-qa.mjs` still pass.

`node scripts/jianying-export-qa.mjs` (AICUT_PYTHON with pyJianYingDraft 0.3.1 on Python 3.14, AICUT_FFMPEG for synthetic MP4/PNG/WAV): AiCut manifest → `export_jianying.py` → `draft_content.json` with video track (still + split video, correct source start), trimmed BGM at -6 dB (volume ≈0.5), overlapping clip on its own lane, Traditional Chinese subtitles timed across the shot, 1080×1920 canvas.

Not verified: a live herdr server (none runs on the development PC; the adapter follows the herdr 0.9.5 API schema), real ElevenLabs or model calls, opening the generated draft in 剪映, real production media.

## v0.6 frame region checks — 2026-11-04

`npm.cmd test`: 34/34. New `tests/regions.test.mjs` covers atomic replace and revision bump, rejection of boxes outside the frame / under 0.5% / non-integer / bad time / over 20 boxes / no media / stale revision (saved boxes untouched on failure), regions in the immutable job snapshot and runner instruction, stale-adoption block after editing boxes, segment-bounded times, split copying a box into every overlapping segment with clipped times, backup restore and v4→v5 migration with a pre-upgrade snapshot. Existing migration tests now expect schema 5.

`node scripts/regions-browser-qa.mjs` (installed Chrome headless, synthetic PNG and WebM): real mouse drags drew boxes on a 9:16 still and a paused video frame; a tiny drag was ignored; the new box focused its note; the drawing layer matched the picture exactly; annotated frame and mask exports kept the 540×960 source size with original pixels outside, a red edge on the box and white-inside/black-outside mask; save, clear-all and reload persisted; the card overlay matched the letterboxed picture and dimmed boxes outside their time span; copied request text listed position, percentages and the "outside unchanged" rule (no time text for stills); end-before-start blocked saving; mobile 390px had no horizontal overflow; no runtime exceptions. One bug found and fixed during QA: a closing video dialog fired a pause event into a cleared handler. `node scripts/browser-smoke.mjs` still passes. Screenshots inspected: `test-results/regions-dialog.png`, `regions-video-dialog.png`, `regions-card.png`, `regions-mobile.png`.

Not verified: real production media, whether a real model respects the boxes, and pixel compositing (not implemented).

## v0.2 segmentation checks — 2026-11-03

Eleven integration tests passed. Added checks cover a 30-second source split into five adjacent ranges using one media file; preserved original take; later-shot ordering; independent notes; recursive splitting; atomic invalid-cut rejection; image and stale-write rejection; trimmed-range backup restore; and a legacy v1 database migration with a pre-upgrade snapshot and intact drafts/media.

The isolated Chrome test also passed: imported a real synthetic WebM, opened the segmentation dialog, created five ranges, added/removed a playhead cut, edited a boundary, saved seven total cards, edited a segment's notes independently, looped a segment and paused at its end with looping disabled, copied its time-range context, saved a trimmed take and reloaded the page. No runtime exceptions or mobile horizontal overflow. Screenshots were inspected. Preview boundary timing is approximate, not frame-accurate export.
