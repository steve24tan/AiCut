# CLI verification — v0.3, 2026-11-03

Twenty-one local integration tests passed. Task checks include:

- Queued native work completes without changing the draft, and explicit adoption preserves an old-text snapshot and adopted media.
- Exclusive manual claim, duplicate prevention and stale adoption protect concurrent edits.
- Invalid results, cancellation, failures and service-restart interruption remain visible.
- Native tasks are serialized; cancelling one releases the next queued task.
- Task snapshots/results survive backup and v2-to-v3 migration creates a pre-upgrade snapshot.
- Synthetic subprocesses exercise Claude JSON structured output and Codex final-output-file protocols with stdin and API environment removal.
- API-key login types are refused before inference.
- The actual local command bridge reads, claims and completes a manual task, including a UTF-8 BOM result file.

Installed Claude Code/Codex help was inspected; both installed login types were checked and confirmed subscription-style without submitting a model request. No tokens or account details were printed.

Isolated Chrome QA used an injected synthetic executor. It passed per-shot push, task status/result inspection and explicit adoption, with active media preserved and no browser runtime exceptions. Existing import/segmentation/range preview/reload/mobile checks passed too. A previous run timed out waiting for the trim dialog during the expanded smoke test; the repeat with diagnostics completed successfully.

These checks do not prove real model inference, available subscription quota, provider-generated quality, media understanding or actual video editing. Native tasks currently rewrite text prompts only. Real CLI output must still be exercised through an intentional user task. The CLI screenshot contains only synthetic content.
