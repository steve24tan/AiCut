# Shot Workbench · 逐段

**Keep every shot, prompt and revision together — on your own computer.**

English | [简体中文](README.zh-CN.md)

Shot Workbench is a small local workspace for creators who generate content in other tools. Organize clips or text into shot cards, write a prompt and revision notes under each one, copy the complete request into your preferred tool, then import the next take.

No AI API, account, cloud upload or npm dependencies. The current interface is in Simplified Chinese. This is an early `v0.2.0` implementation, with synthetic integration and browser checks; real production workflows still need testing.

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

You can also import several files to create one shot per file.

### Split a longer video

Import the full video, then click **✂ 分段** on its card. Choose five segments for a 30-second video to start with 0–6, 6–12, 12–18, 18–24 and 24–30 seconds. Edit a boundary in seconds, or click **在播放位置分段** to cut at the playhead. Remove unneeded boundaries before saving. Each segment must be at least 0.1 seconds; one split supports up to 100 segments.

The first segment uses the original card; the others are inserted directly after it. They share one media file and inherit the prompt. The first retains existing notes; new cards start with empty notes. The original full take remains in the first card's history. Existing later cards keep their order.

**调整范围** changes an individual segment's start/end as a new take. It does not move neighboring boundaries. Cards loop within the range by default; turn off **单段循环** to pause at the end. The horizontal navigator jumps between shots. Copied requests and Markdown exports include the source filename and range.

![Video segmentation with editable boundaries. Synthetic fixture.](docs/images/segmentation.png)

These are non-destructive playback ranges, not separately encoded clips. Automatic scene detection, frame-accurate cutting/export and stitched continuous playback are not included. Preview boundaries use approximate browser timing.

The first upgrade from schema v1 saves a pre-upgrade database snapshot in the data directory, then adds range fields transactionally. Back up the complete data and media before upgrading. Do not open upgraded data with v0.1 code.

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

On macOS/Linux, the equivalent start command is `SHOT_DATA_DIR=./restored-data npm start`. Windows is tested locally; the initial release also passed Windows/Linux CI. See GitHub Actions for each subsequent commit.

## Development

```sh
npm test
```

Eleven integration checks cover restart persistence, immutable snapshots, stale-write rejection, ordering, media ranges, backup restore, local request boundaries, five-way splitting, recursive splitting, range validation and schema migration.

An optional Chrome browser smoke test is available with `node scripts/browser-smoke.mjs`. It uses temporary data, imports synthetic PNG/WebM fixtures and writes a screenshot to `test-results/`. It defaults to the standard Windows Chrome path; set `CHROME_PATH` for another installation. This optional test is separate from CI.

See [architecture](ARCHITECTURE.md), [verification](VERIFICATION.md), [contributing](CONTRIBUTING.md) and [security scope](SECURITY.md).

## Current limits

- Browser codec support determines playback; importing MOV does not guarantee playback.
- Maximum file size is 1 GB. Large files, disk-full conditions and production workloads are not benchmarked.
- Ordering uses arrow buttons. Parallel take comparison, encoded clip export, folder watching and portable project import are planned, not implemented.
- Designed for one user on one computer. Multi-user authentication and network hosting are outside the current scope.

## Acknowledgments and license

Interaction and storage ideas were informed by [Clapshot](https://github.com/elonen/clapshot), [StoryBored](https://github.com/storybored-app/storybored) and [Wonder Unit Storyboarder](https://github.com/wonderunit/storyboarder). This is an independent implementation; no upstream source was copied. Those projects retain their respective licenses and are not affiliated with this project.

Source is available under the [MIT License](LICENSE). Imported media remains subject to its own rights and licenses.
