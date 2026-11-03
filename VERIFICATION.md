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
- No automatic scene splitting, timeline cutting, side-by-side comparison or folder watcher is implemented.
- No hosted site, model API or subscription automation exists.
- Test servers shut down after validation. Start the real workspace with `start.cmd`; its data starts empty.
- Cross-platform GitHub Actions checks are configured for Node 24 on Windows and Linux. Their remote results have not yet been verified.
