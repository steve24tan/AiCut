# Local CLI bridge

## herdr agents (v0.7)

When the `herdr` CLI is on PATH (or `SHOT_HERDR_BIN` points at it) and a herdr server is running for the same user, AiCut lists live agents (`GET /api/herdr/agents`, from `herdr agent list`). Every "交给谁" dropdown — per-shot prompt jobs, audio processing, mix, dubbing, BGM generation — offers those agents next to "手动 · 复制指令". Choosing one creates the task in AiCut and types a single-line pointer into that pane with `herdr agent prompt <name> "<text>"`; the agent reads and claims the task with `cli.mjs`, so it keeps its own model, tools, MCP servers and project context (e.g. the GA lead). AiCut refuses to type into an agent whose state is `working` or `blocked`; the refused task stays visible as failed. Manual tasks copy the same pointer to the clipboard instead.

Audio tasks:

```sh
node cli.mjs tasks list [PROJECT_ID]
node cli.mjs tasks read TASK_ID
node cli.mjs tasks claim TASK_ID
node cli.mjs audio version CLIP_ID out.wav --note "drums -9 dB"
node cli.mjs audio add TRACK_ID line.mp3 --offset 2.5 --title "Lorraine · 欢迎"
node cli.mjs tasks complete TASK_ID --file result.json   # {"summary":"…","outputs":[…]}
node cli.mjs tasks fail TASK_ID --message "reason"
```

Kinds: `process` (one clip: notes + time-range boxes + local file paths), `mix` (2–6 clips, output track), `voice` (a shot's dialogue with each character's voice_id/notes, voice track and the shot's timeline offset), `music` (description, length, offset, BGM track). Prompt jobs gained the same `jobs fail` command and a `herdr` provider. Restarting AiCut marks claimed (running) work interrupted, as before; queued herdr/manual work stays queued.

Use a new Claude Code/Codex task started by a card, or read/complete queued work from your existing agent session. Both preserve a task snapshot and require explicit adoption in the UI.

## Automatic dispatch

Install and sign in to the CLI with a subscription account, then restart the server. Select it under a card and click **推送任务**. It returns a complete revised text prompt and summary. **查看任务 / 结果** shows the input/result; **采用结果** updates the draft, preserving its old text snapshot and adopted media.

Availability means an executable was found. Each run checks login type. Quota/auth/version errors appear as failures. One task runs at a time with a ten-minute timeout and one-megabyte output limit. No automatic retries. Restart interrupts native work; unclaimed manual tasks remain queued, while claimed manual work becomes interrupted.

The CLI receives project/shot titles, prompt, notes, source revision, adopted-take metadata including time range, references and frame regions. Each region has `number`, `placement` (for example 右下), `box_percent` {left, top, width, height} as % of the frame from the top-left, segment-relative `start_ms`/`end_ms` (null = segment end) and `note`; the instruction tells the CLI to apply each note only inside its box and keep everything else unchanged. Video bytes and annotated frames are not attached. It revises text, not media. Native dispatch starts a new process; it does not inject messages into an existing chat.

## Existing agent session

### Import and split without the file picker

Run these commands with the server running:

```sh
node cli.mjs projects create "My project"
node cli.mjs projects
node cli.mjs import PROJECT_ID "path/to/source.mp4" --segments 5 --duration 30
```

Use the project ID returned by create/list. The example splits a known 30-second source into five ranges. Use `--title NAME` to name the imported card. Without split options, import simply creates one shot and take. Supported files match the browser's import formats.

Omit `--duration` to read duration through optional ffprobe. It must be installed on PATH, or specified by `SHOT_FFPROBE_BIN`. No ffprobe and no known duration means the command fails before uploading. A supplied duration is trusted metadata; confirm it is correct. Original file bytes remain unchanged. No ffprobe installation was performed automatically.

Custom and recursive ranges:

```sh
node cli.mjs split SHOT_ID --cuts 5,12,18,25 --duration 30
node cli.mjs split RANGED_SHOT_ID --segments 2
```

Cuts are absolute seconds in the original source and must be increasing inside the current range. Ranged takes retain source duration; an unranged existing take can be probed through its local media URL or use --duration.

CLI input/range validation happens before import. Upload and split are separate server operations: a network failure may leave an empty shot, or an imported unsplit shot. Errors report that shot ID; inspect it and retry split instead of repeating import blindly. No automatic deletion or retry occurs.

The open page detects shot changes when idle. Unsaved edits or an open dialog delay refresh. Metadata reads are lightweight; a full reload is used only when a changed shot set is detected.

### Read and complete a manual text task

Select **外部 CLI 领取** on the card and push. While the server runs, ask your existing agent to run these commands from this repository:

```sh
node cli.mjs projects
node cli.mjs shots PROJECT_ID
node cli.mjs jobs list
node cli.mjs jobs read JOB_ID
node cli.mjs jobs claim JOB_ID
```

Read returns the immutable requirements/range snapshot. Claim is exclusive. Have the agent revise that shot and write UTF-8 JSON:

```json
{
  "revised_prompt": "The complete revised prompt, not a patch.",
  "summary": "A short explanation of the changes."
}
```

Return it with:

```sh
node cli.mjs jobs complete JOB_ID --file result.json
```

The page polls for results. Complete does not overwrite the draft: adopt in the UI after reviewing. To cancel:

```sh
node cli.mjs jobs cancel JOB_ID
```

Set `SHOT_WORKBENCH_URL` for a different local port; only loopback HTTP is accepted. No watcher injects jobs into an existing chat: the agent must explicitly read/claim them.

## State and conflicts

`queued -> running -> completed -> applied`; queued/running tasks can be cancelled, and running work can fail or become interrupted. One queued/running job per shot prevents duplicate dispatch. If the shot changes after pushing, adoption is blocked; keep the newer draft and copy the result for manual merging. Adoption transactionally saves the prior text and changes prompt/status. Notes and media remain unchanged.

## Adapter details

Claude uses print/JSON-schema output with tools/MCP disabled and user/project settings excluded. Do not use bare mode here: it does not load subscription OAuth credentials. Codex uses exec/read-only, stdin, an output schema and final-output file; user config is excluded. API-key login types are rejected and common API-key environment overrides removed. Neither adapter uses permission-bypass flags. CLI-managed auth and subscription terms still apply.

Local installation and subscription login types were verified. Development tests use synthetic subprocesses/executors; they do not verify real inference, account quota or generation quality.

Schema v3 adds jobs; v2 is snapshotted to `schema-v2-before-v3.sqlite` before migration. Do not open upgraded data with old code. Standard backups retain job inputs/results in SQLite. `data/jobs/<id>/` contains request/schema/result files and optional raw diagnostics; these auxiliary files are not included in standard backups and must not be published. The application does not read/copy auth files into them.

For nonstandard installs, set `SHOT_CLAUDE_BIN` / `SHOT_CODEX_BIN` to an absolute executable or JS entry point before starting. Batch/PowerShell wrappers are not executed; npm locations resolve to native/Node entries. Executable paths cannot be configured from HTTP.

References: [Claude programmatic use](https://code.claude.com/docs/en/headless), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/). Adapter development also checks installed CLI help.
