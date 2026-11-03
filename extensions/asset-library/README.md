# Asset Library extension

An optional built-in module for communicating creative feel with concrete references. Toggle **素材库扩展** in the top bar. Disabled by default; its switch is remembered in this browser. Closing it hides the panel and disables drag-to-attach without removing existing references or media.

## Use

1. Import/drop local MP3/WAV/OGG/M4A/FLAC, GIF/PNG/JPG/WebP and MP4/WebM/MOV files into the panel. Browser codec support determines preview capability.
2. Audition/preview, then edit the title, comma-separated tags, source URL, author and license record. Search names/tags and favorite reusable items.
3. Drag an item onto a shot, or click a shot then **添加到当前段**. Enter its segment-relative second and describe the intended feeling/use.
4. **查看 / 调整** previews/edits the link. **解除关联** removes only that shot's link, preserving the original in the library.
5. Copy the request or push a CLI job. It contains reference metadata and notes, **not media bytes**. No automatic audio understanding or multimodal analysis is claimed.
6. **下载原素材** downloads a local copy for your finishing editor. Cross-application drag-out is not implemented/tested.

This version provides independent audition and reference links. It does not synchronize an audio mix, place overlays on the source video or render a composite. No third-party sound/meme collection is bundled.

## Extension boundary

A built-in optional module, not a marketplace or untrusted JavaScript loader. GET /api/extensions exposes its manifest, including id/version/capabilities and rendered_mix=false. Browser code is public/library.js and library.css; persistence is src/library.mjs. No runtime dependency or external service is required. Native audio controls provide initial audition; waveform UI can be evaluated separately.

The library is local and shared across projects. Originals are immutable files in data/media, without a deletion API. Schema v4 adds library_assets and shot_refs; v3 is snapshotted to schema-v3-before-v4.sqlite before upgrade. SQLite+media backups preserve the library. Do not open upgraded data with older code.

Links attach to shot IDs and relative offsets. Reordering preserves them. Splitting moves an in-range reference to the new segment containing its source time and recalculates its offset. Out-of-range links are retained and flagged after a shorter range. Importing a take does not retime references silently.

Reference/context metadata changes increment affected shot revisions, blocking stale CLI-result adoption. Favoriting does not invalidate tasks. Job snapshots retain exact reference metadata from dispatch, including after edits/unlinking.

## Local API

- GET /api/extensions
- GET /api/library/assets
- POST /api/library/import?filename=NAME (binary stream)
- PATCH /api/library/assets/:id (metadata, asset revision)
- POST /api/shots/:id/references (asset_id, offset_ms, note, shot revision)
- PATCH /api/shots/:id/references/:ref (offset_ms, note, shot revision)
- DELETE /api/shots/:id/references/:ref (shot revision)

Project/shot details expose references. Originals use /media/:id. Existing local-origin/header checks protect writes. Source/author/license fields record user-supplied provenance, not a rights certification. No code was copied from the surveyed asset managers.
