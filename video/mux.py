"""Lay narration clips at their scene marks, mux with the screen recording, write captions (SRT)."""
import json, subprocess, re
from pathlib import Path

B = Path(__file__).parent / "build"
marks = json.loads((B / "marks.json").read_text())
dur = json.loads((B / "audio" / "durations.json").read_text())
segs = json.loads((Path(__file__).parent / "narration.json").read_text())
LEAD = 0.25

inputs, filters = [], []
for i, s in enumerate(segs):
    inputs += ["-i", str(B / "audio" / f'{s["id"]}.wav')]
    ms = int((marks[s["id"]] + LEAD) * 1000)
    filters.append(f"[{i + 1}:a]adelay={ms}|{ms},aformat=channel_layouts=stereo[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(segs))) + f"amix=inputs={len(segs)}:normalize=0,volume=1.0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
total = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(B / "screen.mp4")]).decode())
vf = f"fade=t=in:st=0:d=0.6,fade=t=out:st={total - 1.2:.2f}:d=1.2"
cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(B / "screen.mp4"), *inputs, "-filter_complex", ";".join(filters) + ";" + mix + f";[0:v]{vf}[vout]",
       "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
       "-movflags", "+faststart", "-t", f"{total:.2f}", str(Path(__file__).parent / "ProofOfForest-demo.mp4")]
subprocess.run(cmd, check=True)

# captions: split each clip into sentences, timed proportionally to characters
def ts(t):
    h, rem = divmod(t, 3600); m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"
srt, n = [], 1
for s in segs:
    start, d = marks[s["id"]] + LEAD, dur[s["id"]]
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", s["text"]) if p.strip()]
    total_chars = sum(len(p) for p in parts)
    t = start
    for p in parts:
        pd = d * len(p) / total_chars
        srt.append(f"{n}\n{ts(t)} --> {ts(t + pd)}\n{p}\n")
        n += 1
        t += pd
(Path(__file__).parent / "ProofOfForest-demo.srt").write_text("\n".join(srt))
print("ok", total)
