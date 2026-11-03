# Working with Shot Workbench

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

## Development

The optional asset-library module associates references without replacing active video. See extensions/asset-library/README.md. Preserve originals, provenance, revision guards and reference relocation during splitting. CLI snapshots include metadata, not media bytes; do not claim automatic audio understanding or a rendered mix.

Run `npm test` after behavioral changes. Runtime data, task files, credentials and private media must not be committed. Do not invoke a real model to test the bridge without user authorization; synthetic fixtures are provided. Preserve revision conflicts, immutable takes and the backup contract.
