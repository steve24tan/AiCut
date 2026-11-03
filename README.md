# Shot Workbench · 逐段

**Keep every shot, prompt and revision together — on your own computer.**

English | [简体中文](README.zh-CN.md)

Shot Workbench is a small local workspace for creators who generate content in other tools. Organize clips or text into shot cards, write a prompt and revision notes under each one, copy the complete request into your preferred tool, then import the next take.

No AI API, account, cloud upload or npm dependencies. The current interface is in Simplified Chinese. This is an early `v0.1.0` implementation, with synthetic integration and browser checks; real production workflows still need testing.

![Shot cards with prompts, revision notes and take selection. All content is synthetic test data.](docs/images/workbench.png)

## Features

- Multiple projects and ordered shot cards.
- Local image and browser-compatible video previews.
- Autosaved prompts and revision notes beneath each shot.
- Complete revision requests copied with project, shot and current-take context.
- Immutable prompt/notes snapshots for each imported take.
- Active-take selection without overwriting the next draft.
- Text-only snapshots, status filters and Markdown export.
- SQLite and original media backed up together.

## Run locally

Install **Node.js 24 or newer**, download or clone this repository, and run this command from its directory:

```sh
npm start
```

Open **http://127.0.0.1:4317** in Chrome or Edge. Keep the terminal running; press Ctrl+C to stop.

On Windows, you can also double-click `start.cmd`. In PowerShell, use `npm.cmd start` if your execution policy prevents `npm.ps1` from running. No `npm install` step is necessary.

### Your first revision

1. Create a project (新建项目) and add a shot (添加片段).
2. Fill in **Prompt** and **修改要求** (revision request).
3. Click **复制本段修改请求** to copy the context into the tool you already use.
4. Generate or edit content outside Shot Workbench.
5. Click **导入新版** to attach the result as a new take. The previous take remains available.

You can also import several files to create one shot per file. A full video is currently treated as one clip; automatic shot detection and cutting are not included.

## Data and backups

The server listens on `127.0.0.1` only. Files are copied from your browser to your local application folder. There are no third-party scripts, fonts or runtime services.

```text
data/
  workbench.sqlite       Projects, shots, drafts, takes and media index
  media/                 Original media copies
backups/
  <timestamp>/           Consistent database snapshot plus media
```

Run a complete backup from the repository directory:

```sh
npm run backup
```

Use only a backup that reports `Backup complete`. To restore, stop the server, copy the complete timestamped backup directory to a **new** folder, and point `SHOT_DATA_DIR` at it before starting. Do not restore just the SQLite file. A Markdown export contains text only and is not a project backup.

PowerShell example after copying a complete backup to `restored-data`:

```powershell
$env:SHOT_DATA_DIR = Join-Path (Get-Location) 'restored-data'
npm.cmd start
```

On macOS/Linux, the equivalent start command is `SHOT_DATA_DIR=./restored-data npm start`. Windows has been tested locally; cross-platform CI is configured but its remote results are not yet verified.

## Development

```sh
npm test
```

Seven integration checks cover persistence across restart, immutable take snapshots, stale-write rejection, ordering, media byte ranges, backup restore and local request boundaries.

An optional Chrome browser smoke test is available with `node scripts/browser-smoke.mjs`. It uses temporary data, imports synthetic PNG/WebM fixtures and writes a screenshot to `test-results/`. It defaults to the standard Windows Chrome path; set `CHROME_PATH` for another installation. This optional test is separate from CI.

See [architecture](ARCHITECTURE.md), [verification](VERIFICATION.md), [contributing](CONTRIBUTING.md) and [security scope](SECURITY.md).

## Current limits

- Browser codec support determines playback; importing MOV does not guarantee playback.
- Maximum file size is 1 GB. Large files, disk-full conditions and production workloads are not benchmarked.
- Ordering uses arrow buttons. Parallel take comparison, timeline cuts, folder watching and portable project import are planned, not implemented.
- Designed for one user on one computer. Multi-user authentication and network hosting are outside the current scope.

## Acknowledgments and license

Interaction and storage ideas were informed by [Clapshot](https://github.com/elonen/clapshot), [StoryBored](https://github.com/storybored-app/storybored) and [Wonder Unit Storyboarder](https://github.com/wonderunit/storyboarder). This is an independent implementation; no upstream source was copied. Those projects retain their respective licenses and are not affiliated with this project.

Source is available under the [MIT License](LICENSE). Imported media remains subject to its own rights and licenses.
