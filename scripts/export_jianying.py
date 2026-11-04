"""Turn an AiCut timeline manifest (*.aicut-timeline.json) into a JianYing (剪映) draft.

Usage:
    pip install pyJianYingDraft
    python scripts/export_jianying.py manifest.json --drafts "C:/Users/<you>/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft"
        [--name "EP02 v3"] [--width 1080 --height 1920] [--replace] [--no-subtitles]

Then restart JianYing (or re-enter the draft list) to see the draft. Generation works with any
JianYing version; automatic export via pyJianYingDraft only works on JianYing 6.x and earlier.

MODIFICATION HISTORY
  2026-11-04  First version: video/image track, AiCut audio tracks (overlaps split onto extra
              tracks), dialogue as subtitles placed in the platform safe area.
"""
import argparse
import json
import os
import sys

MS = 1000  # pyJianYingDraft works in microseconds


def timerange(draft, start_ms, duration_ms):
    return draft.Timerange(int(start_ms) * MS, max(1, int(duration_ms)) * MS)


def lanes(clips):
    """JianYing tracks cannot overlap; spread overlapping clips over extra lanes."""
    result = []
    for clip in sorted(clips, key=lambda c: c["timeline_start_ms"]):
        for lane in result:
            last = lane[-1]
            if clip["timeline_start_ms"] >= last["timeline_start_ms"] + last["duration_ms"]:
                lane.append(clip)
                break
        else:
            result.append([clip])
    return result


def main():
    parser = argparse.ArgumentParser(description="AiCut timeline manifest -> JianYing draft")
    parser.add_argument("manifest")
    parser.add_argument("--drafts", required=True, help="JianYing drafts folder (…/com.lveditor.draft or JianyingPro Drafts)")
    parser.add_argument("--name", help="draft name (default: project title)")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--replace", action="store_true", help="overwrite an existing draft with the same name")
    parser.add_argument("--no-subtitles", action="store_true")
    args = parser.parse_args()

    try:
        import pyJianYingDraft as draft
        from pyJianYingDraft import TextStyle, ClipSettings
    except ImportError:
        sys.exit("pyJianYingDraft is not installed. Run: pip install pyJianYingDraft")

    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("format") != "aicut-timeline":
        sys.exit("Not an AiCut timeline manifest")
    if not os.path.isdir(args.drafts):
        sys.exit(f"Drafts folder not found: {args.drafts}")

    name = args.name or manifest["project"]["title"]
    script = draft.DraftFolder(args.drafts).create_draft(name, args.width, args.height, allow_replace=args.replace)

    # Video: one track, shots back to back. Empty shots leave a gap.
    script.append_track(draft.TrackSpec(draft.TrackType.video, "画面"))
    missing = []
    for shot in manifest["video"]:
        if not shot["path"]:
            continue
        if not os.path.isfile(shot["path"]):
            missing.append(shot["path"])
            continue
        target = timerange(draft, shot["timeline_start_ms"], shot["duration_ms"])
        if shot["kind"] == "video":
            segment = draft.VideoSegment(shot["path"], target, source_timerange=timerange(draft, shot["source_start_ms"], shot["duration_ms"]))
        else:
            segment = draft.VideoSegment(shot["path"], target)  # still image held for the shot duration
        script.add_segment(segment, "画面")

    # Audio: each AiCut track becomes one or more JianYing tracks (extra lanes only where clips overlap).
    used = set()
    for track in manifest["audio"]:
        volume = 0.0 if track["muted"] else 10 ** (track["gain_db"] / 20)
        for index, lane in enumerate(lanes(track["clips"])):
            base = track["title"] if index == 0 else f'{track["title"]} ({index + 1})'
            label, n = base, 2
            while label in used:
                label, n = f"{base} #{n}", n + 1
            used.add(label)
            script.append_track(draft.TrackSpec(draft.TrackType.audio, label))
            for clip in lane:
                if not os.path.isfile(clip["path"]):
                    missing.append(clip["path"])
                    continue
                segment = draft.AudioSegment(clip["path"], timerange(draft, clip["timeline_start_ms"], clip["duration_ms"]),
                                             source_timerange=timerange(draft, clip["source_start_ms"], clip["duration_ms"]), volume=volume)
                script.add_segment(segment, label)

    # Dialogue as subtitles around 72% of the frame height, above TikTok/Shorts bottom UI.
    if manifest["subtitles"] and not args.no_subtitles:
        script.append_track(draft.TrackSpec(draft.TrackType.text, "台词"))
        for line in manifest["subtitles"]:
            script.add_segment(draft.TextSegment(line["text"], timerange(draft, line["start_ms"], line["duration_ms"]),
                                                 style=TextStyle(size=6.0, auto_wrapping=True, max_line_width=0.82, align=1),
                                                 clip_settings=ClipSettings(transform_y=-0.44)), "台词")

    script.save()
    print(f'Draft "{name}" written to {args.drafts}')
    if missing:
        print("Skipped missing files:\n  " + "\n  ".join(missing), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
