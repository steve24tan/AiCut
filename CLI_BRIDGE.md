# Local CLI bridge

Use a new Claude Code/Codex task started by a card, or read/complete queued work from your existing agent session. Both preserve a task snapshot and require explicit adoption in the UI.

## Automatic dispatch

Install and sign in to the CLI with a subscription account, then restart the server. Select it under a card and click **推送任务**. It returns a complete revised text prompt and summary. **查看任务 / 结果** shows the input/result; **采用结果** updates the draft, preserving its old text snapshot and adopted media.

Availability means an executable was found. Each run checks login type. Quota/auth/version errors appear as failures. One task runs at a time with a ten-minute timeout and one-megabyte output limit. No automatic retries. Restart interrupts native work; unclaimed manual tasks remain queued, while claimed manual work becomes interrupted.

The CLI receives project/shot titles, prompt, notes, source revision and adopted-take metadata including time range. Video bytes are not attached. It revises text, not media. Native dispatch starts a new process; it does not inject messages into an existing chat.

## Existing agent session

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
