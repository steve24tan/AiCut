# Working with AiCut

This is a local Node.js 24+ application. Follow the parent/global policy applicable to your workspace. Read CLI_BRIDGE.md before controlling the workspace from an agent.

## Importing a user's local media

- Keep the local server running; its default URL is http://127.0.0.1:4317.
- Use `node cli.mjs projects` to find the intended project, or `node cli.mjs projects create NAME` when the user asks for a new one.
- Use `node cli.mjs import PROJECT_ID FILE --segments COUNT` to import and split. Paths with spaces must be passed as one argument. This copies the original into local storage; it does not upload it to a model provider.
- Duration is read with optional ffprobe, or supplied with `--duration SECONDS` when the user has given a known duration. Never invent a duration. If unknown and probing fails, report that requirement rather than assuming 30 seconds.
- Use `--cuts 5,12,18,25 --duration 30` for explicit source-time cut points. Use `node cli.mjs split SHOT_ID --segments COUNT` for recursive splitting of an existing range.
- Read the JSON command result. After a partial upload/split failure, use the returned shot ID to inspect or retry split; do not blindly import again and create duplicates.
- The browser refreshes external shot changes when it is idle. Pending user edits and open dialogs delay refresh.
- Splits are non-destructive time ranges, not encoded clip files or automatic scene detection. Never claim an export exists when only ranges were saved.

## Handling an AiCut task pushed to you (herdr or pasted)

AiCut types a one-line pointer such as `[AiCut] 新任务 <id>（处理音频：…）` into your pane, or the user pastes it. Then:

1. `node cli.mjs tasks read TASK_ID` (audio) or `node cli.mjs jobs read JOB_ID` (prompt rewrite). The snapshot is the full request: notes, time-range boxes (`regions`, source-file ms), local file paths of every version, dialogue with each character's `voice_id`, and a `deliver` command line.
2. `tasks claim TASK_ID` before working, so the user sees it is in progress.
3. Do the work with your own tools. Local processing (stem split, gain changes, crossfades with ffmpeg) is preferred when the request can be done without regenerating; online generation (e.g. ElevenLabs TTS/music via its MCP server) costs the user's credits, so use it only for voice and music generation tasks or when the instruction asks for it. Keep everything outside the boxed time ranges unchanged.
4. Return audio only through `deliver`: `node cli.mjs audio version CLIP_ID FILE --note "…"` adds a new version (the old one stays for A/B), `node cli.mjs audio add TRACK_ID FILE --offset SECONDS --title "…"` adds a clip. Never overwrite files under `data/`. A depth map for 2.5D parallax goes in with `node cli.mjs motion depth SHOT_ID depth.png` (white = near, same aspect as the still).
5. `tasks complete TASK_ID --file result.json` with `{"summary":"…","outputs":[{"clip_id":"…","version_id":"…"}]}`, or `tasks fail TASK_ID --message "reason"` when it cannot be done. Do not fake success.

## Development

The optional asset-library module associates references without replacing active video. See extensions/asset-library/README.md. Preserve originals, provenance, revision guards and reference relocation during splitting. CLI snapshots include metadata, not media bytes; do not claim automatic audio understanding or a rendered mix.

Audio timeline (src/audio.mjs, public/timeline.js), dialogue/characters (src/voices.mjs, public/voices.js), agent tasks (src/tasks.mjs, src/herdr.mjs, public/tasks.js) and the 剪映 manifest (src/export.mjs, scripts/export_jianying.py) follow the same rules: revision guards on every write, media is append-only, results become new versions. AiCut never processes or generates audio itself.

Run `npm test` after behavioral changes. Runtime data, task files, credentials and private media must not be committed. Do not invoke a real model to test the bridge without user authorization; synthetic fixtures are provided. Preserve revision conflicts, immutable takes and the backup contract.
