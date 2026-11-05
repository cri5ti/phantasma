"""Audio analysis for mvgen.

Writes <out_dir>/analysis.json plus binary feature tracks sampled at RATE Hz:
  bands.u8   frames x N_BANDS  log-mel band energy, per-band normalised 0..255
  scalars.u8 frames x 6        rms, bass, mid, high, onset, centroid (0..255)
  wave.i8    frames x WAVE_N   short oscilloscope window centred on each frame

Usage: python analyze.py <audio> <out_dir>
"""
import json
import os
import sys
import warnings

import numpy as np
import librosa
import scipy.ndimage as ndi
import scipy.signal as sig

warnings.filterwarnings("ignore")

SR = 24000
RATE = 60            # feature frames per second
HOP = SR // RATE     # 400
N_FFT = 2048
N_BANDS = 48
WAVE_N = 128
WAVE_WIN = 1024


def norm(x, lo_p=2.0, hi_p=99.7):
    lo, hi = np.percentile(x, lo_p), np.percentile(x, hi_p)
    return np.clip((x - lo) / max(hi - lo, 1e-9), 0, 1)


def to_u8(x):
    return np.round(np.clip(x, 0, 1) * 255).astype(np.uint8)


def band_db(S_pow, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return librosa.power_to_db(S_pow[m].sum(axis=0) + 1e-12)


def section_tempo(oenv, a, b, fallback):
    """Autocorrelation tempo for a slice of the onset envelope, parabolic-refined.
    Returns (bpm folded into 100..190, [alternate bpms])."""
    fr = SR / HOP
    o = oenv[int(a * fr):int(b * fr)]
    if len(o) < fr * 4:
        return fallback, []
    o = o - o.mean()
    ac = np.correlate(o, o, "full")[len(o) - 1:]
    lo, hi = int(fr * 60 / 200), int(fr * 60 / 50)
    cands = []
    for j in sig.find_peaks(ac[lo:hi])[0] + lo:
        d = 0.5 * (ac[j - 1] - ac[j + 1]) / (ac[j - 1] - 2 * ac[j] + ac[j + 1] + 1e-12)
        cands.append((float(ac[j]), 60 * fr / (j + d)))
    if not cands:
        return fallback, []
    cands.sort(reverse=True)
    def fold(t):
        while t < 100: t *= 2
        while t > 190: t /= 2
        return t
    best = fold(cands[0][1])
    alts = []
    for _, t in cands[1:6]:
        if all(abs(t - x) > 2 for x in alts + [best]):
            alts.append(round(t, 1))
    return round(best, 2), alts[:3]


def detect_sections(y, sr, beats, oenv, rms, duration):
    """Novelty-based boundaries on beat-synchronous timbre/harmony/energy."""
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP, n_mfcc=13)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    feats = np.vstack([
        librosa.util.normalize(mfcc, axis=1) if False else (mfcc - mfcc.mean(1, keepdims=True)) / (mfcc.std(1, keepdims=True) + 1e-9),
        (chroma - chroma.mean(1, keepdims=True)) / (chroma.std(1, keepdims=True) + 1e-9),
        ((rms - rms.mean()) / (rms.std() + 1e-9))[None, : mfcc.shape[1]] * 2.0,
    ])
    # beat-synchronous, then smooth over 4 beats
    bf = librosa.util.sync(feats, beats, aggregate=np.median)
    bf = ndi.uniform_filter1d(bf, 2, axis=1)
    bt = librosa.frames_to_time(np.concatenate([beats, [feats.shape[1]]]), sr=sr, hop_length=HOP)
    X = librosa.util.normalize(bf, axis=0)
    ssm = X.T @ X
    # checkerboard novelty
    K = 32
    g = sig.windows.gaussian(2 * K, K / 2)
    ker = np.outer(g, g) * np.kron([[1, -1], [-1, 1]], np.ones((K, K)))
    n = ssm.shape[0]
    pad = np.pad(ssm, K, mode="edge")
    nov = np.array([np.sum(pad[i:i + 2 * K, i:i + 2 * K] * ker) for i in range(n)])
    nov = np.maximum(nov, 0)
    nov = nov / (nov.max() + 1e-9)
    min_beats = 16
    peaks, props = sig.find_peaks(nov, distance=min_beats, prominence=0.08)
    order = np.argsort(-nov[peaks])
    peaks = np.sort(peaks[order][:14])
    bounds = [0.0] + [float(bt[p]) for p in peaks if 4 < bt[p] < duration - 4] + [duration]
    return bounds, nov, bt


def main():
    audio, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    y, sr = librosa.load(audio, sr=SR, mono=True)
    duration = len(y) / sr
    n_frames = int(np.ceil(duration * RATE)) + 1
    print(f"loaded {audio}: {duration:.2f}s, {n_frames} frames @ {RATE}Hz", flush=True)

    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP, center=True)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    mel = librosa.feature.melspectrogram(S=S, sr=sr, n_mels=N_BANDS, fmin=30, fmax=11000)
    mel_db = librosa.power_to_db(mel + 1e-12)
    # per-band normalisation keeps highs lively; blend with global so the spectral tilt survives a bit
    per_band = np.stack([norm(b) for b in mel_db])
    glob = norm(mel_db, 5, 99.9)
    bands = 0.7 * per_band + 0.3 * glob

    rms = librosa.feature.rms(y=y, frame_length=N_FFT, hop_length=HOP)[0]
    rms_n = norm(librosa.amplitude_to_db(rms + 1e-9), 3, 99.8) ** 1.3
    bass = norm(band_db(S, freqs, 20, 160), 3, 99.8)
    mid = norm(band_db(S, freqs, 160, 2500), 3, 99.8)
    high = norm(band_db(S, freqs, 2500, 11000), 3, 99.8)
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    onset = np.clip(oenv / np.percentile(oenv, 99.5), 0, 1)
    cent = librosa.feature.spectral_centroid(S=np.sqrt(S), sr=sr)[0]
    cent_n = norm(np.log(cent + 1), 2, 98)

    def fit(a):
        a = np.asarray(a)
        if a.shape[-1] >= n_frames:
            return a[..., :n_frames]
        pad = [(0, 0)] * (a.ndim - 1) + [(0, n_frames - a.shape[-1])]
        return np.pad(a, pad, mode="edge")

    bands = fit(bands)
    scal = np.stack([fit(rms_n), fit(bass), fit(mid), fit(high), fit(onset), fit(cent_n)])

    # oscilloscope windows
    peak = np.percentile(np.abs(y), 99.9) + 1e-9
    ypad = np.pad(y, (WAVE_WIN, WAVE_WIN))
    idx = (np.arange(n_frames) * HOP + WAVE_WIN)[:, None] + np.linspace(-WAVE_WIN / 2, WAVE_WIN / 2, WAVE_N).astype(int)[None, :]
    wave = np.clip(ypad[np.clip(idx, 0, len(ypad) - 1)] / peak, -1, 1)
    wave_i8 = np.round(wave * 127).astype(np.int8)

    to_u8(bands.T).tofile(os.path.join(out, "bands.u8"))
    to_u8(scal.T).tofile(os.path.join(out, "scalars.u8"))
    wave_i8.tofile(os.path.join(out, "wave.i8"))

    # beats
    tempo_g = float(librosa.feature.tempo(onset_envelope=oenv, sr=sr, hop_length=HOP)[0])
    tempo_g = float(section_tempo(oenv, 0, duration, tempo_g)[0])
    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=HOP, start_bpm=tempo_g, tightness=120)
    beat_t = librosa.frames_to_time(beats, sr=sr, hop_length=HOP)
    # downbeat phase (assume 4/4): phase with most bass energy on beat
    bass_f = fit(bass)
    scores = [bass_f[np.clip((beat_t[p::4] * RATE).astype(int), 0, n_frames - 1)].mean() for p in range(4)]
    phase = int(np.argmax(scores))
    downbeats = beat_t[phase::4]

    bounds, nov, bt = detect_sections(y, sr, beats, oenv, rms, duration)
    sections = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        m = (beat_t >= a) & (beat_t < b)
        bpm, alts = section_tempo(oenv, a, b, tempo_g)
        first = float(beat_t[m][0]) if m.any() else a
        e = float(rms_n[int(a * RATE):max(int(b * RATE), int(a * RATE) + 1)].mean())
        sections.append({"start": round(a, 3), "end": round(b, 3), "bpm": bpm, "alt": [float(x) for x in alts],
                         "beatOffset": round(first, 3), "energy": round(e, 3)})

    meta = {
        "version": 1,
        "audio": os.path.basename(audio),
        "duration": duration,
        "rate": RATE,
        "frames": n_frames,
        "nBands": N_BANDS,
        "waveN": WAVE_N,
        "scalars": ["rms", "bass", "mid", "high", "onset", "centroid"],
        "files": {"bands": "bands.u8", "scalars": "scalars.u8", "wave": "wave.i8"},
        "tempo": tempo_g,
        "beats": [round(float(t), 4) for t in beat_t],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "sections": sections,
        "novelty": {"times": [round(float(t), 3) for t in bt[:-1]], "values": [round(float(v), 3) for v in nov]},
    }
    with open(os.path.join(out, "analysis.json"), "w") as f:
        json.dump(meta, f)

    print(f"global tempo {tempo_g:.1f} bpm, {len(beat_t)} beats")
    for s in sections:
        print(f"  {s['start']:7.2f} - {s['end']:7.2f}  {s['bpm']:6.1f} bpm  alt {s['alt']}  energy {s['energy']:.2f}")


if __name__ == "__main__":
    main()
