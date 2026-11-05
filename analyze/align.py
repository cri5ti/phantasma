"""Forced alignment of known lyric words to (ideally vocal-stem) audio with torchaudio's MMS_FA model.

usage: python align.py refine-in.json refine-out.json
  in:  {"audio": path, "lines": [{"words": ["I", "feel", ...], "t0": 30.1, "t1": 33.9}, ...]}
       t0/t1 = rough line window (from the transcript alignment); it's padded and each line aligned on its own,
       so one bad line can't drag the rest.
  out: {"words": [{"t":..,"e":..,"p":..} | null, ...]}  — flattened in input order; null = couldn't align

Needs: pip install torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
The model (~1.2 GB) downloads on first use.
"""
import json
import re
import sys
import unicodedata

import torch
import torchaudio

PAD = 0.6  # s added around each line window


def clean(w: str) -> str:
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z']", "", w).strip("'")


def main(src: str, dst: str) -> None:
    job = json.load(open(src, encoding="utf8"))
    bundle = torchaudio.pipelines.MMS_FA
    print("loading MMS_FA model…", flush=True)
    model = bundle.get_model(with_star=False)
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    sr = bundle.sample_rate

    print(f"loading audio {job['audio']}", flush=True)
    wav, fsr = torchaudio.load(job["audio"])
    wav = wav.mean(0, keepdim=True)
    if fsr != sr:
        wav = torchaudio.functional.resample(wav, fsr, sr)
    total = wav.size(1) / sr

    out = []
    lines = job["lines"]
    for li, line in enumerate(lines):
        words = line["words"]
        toks = [clean(w) for w in words]
        keep = [i for i, t in enumerate(toks) if t]
        res = [None] * len(words)
        t0 = max(0.0, float(line["t0"]) - PAD)
        t1 = min(total, float(line["t1"]) + PAD)
        if keep and t1 - t0 > 0.2:
            seg = wav[:, int(t0 * sr): int(t1 * sr)]
            try:
                with torch.inference_mode():
                    emission, _ = model(seg)
                spans = aligner(emission[0], tokenizer([toks[i] for i in keep]))
                ratio = seg.size(1) / emission.size(1) / sr  # seconds per emission frame
                for i, sp in zip(keep, spans):
                    if not sp:
                        continue
                    score = sum(s.score for s in sp) / len(sp)
                    res[i] = {"t": t0 + sp[0].start * ratio, "e": t0 + sp[-1].end * ratio, "p": float(score)}
            except Exception as e:  # keep going; this line keeps its previous timing
                print(f"line {li + 1}: {e}", flush=True)
        out.extend(res)
        if (li + 1) % 5 == 0 or li + 1 == len(lines):
            print(f"aligned {li + 1}/{len(lines)} lines", flush=True)

    json.dump({"words": out}, open(dst, "w", encoding="utf8"))
    ok = sum(1 for r in out if r)
    print(f"done: {ok}/{len(out)} words aligned", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
