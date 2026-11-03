# Asset Library verification — v0.5

Thirty integration checks include asset import, tags/favorite/provenance persistence, byte-range preview, unsupported media rejection, shot associations in immutable job snapshots, conflict protection after descriptive edits, detach preserving originals, segment-relative relocation during splits, reorder stability, reference editing, backup restore and schema v3-to-v4 snapshot migration.

Isolated installed-Chrome QA uses a generated PCM WAV and PNG. It verifies real audio playback with a user gesture, optional toggle, local import, metadata editing, tag search, favorite, HTML drag/drop to a shot, reference note/offset persistence, copied-request and manual-job context, and preservation when disabled. The existing segmentation, CLI protocol, external-import refresh and mobile checks remain part of the same smoke script. No real model request or third-party media is used.

The first automated audio playback attempt was blocked by Chrome's gesture policy; the QA harness now supplies a simulated user gesture. Application playback remains user-operated through native audio controls.

This is a reference-library workflow, not a synchronization/rendering engine. Cross-application drag-out, mix/export, visual overlays, media understanding by models, large-library performance and real user codec coverage have not been tested. Model tasks contain metadata only. No external asset pack is bundled.
