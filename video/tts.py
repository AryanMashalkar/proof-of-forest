"""Generate narration clips with Kokoro (open-weight neural TTS). Usage: python tts.py <model.onnx> <voices.bin> <out_dir> [voice]"""
import json, sys
from pathlib import Path
import soundfile as sf
from kokoro_onnx import Kokoro

model, voices, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
voice = sys.argv[4] if len(sys.argv) > 4 else "af_heart"
out.mkdir(parents=True, exist_ok=True)
k = Kokoro(model, voices)
durations = {}
for seg in json.loads((Path(__file__).parent / "narration.json").read_text()):
    samples, sr = k.create(seg["text"], voice=voice, speed=1.0, lang="en-us")
    sf.write(out / f'{seg["id"]}.wav', samples, sr)
    durations[seg["id"]] = round(len(samples) / sr, 3)
    print(seg["id"], durations[seg["id"]])
(out / "durations.json").write_text(json.dumps(durations, indent=1))
print("total", round(sum(durations.values()), 1))
