#!/usr/bin/env python3
"""
analyze-stems.py — sanity-check HTDemucs stem output without a reference implementation.

We cannot compare against Python `demucs` (torch is not installed on this machine), so this
checks properties that only hold if the graph is really separating and if we bound the
output tensor with the right stem order.

The model's documented order is: drums, bass, other, vocals  (shape (1,4,2,T)).
Those four have very characteristic spectral shapes, so a wrong order is visible:

    bass      energy almost entirely below ~250 Hz
    drums     broadband, highest crest factor (peak/RMS), transient-heavy
    vocals    concentrated ~200 Hz-4 kHz, low crest factor, mid centroid
    other     everything else, often the brightest

Also reports:
  * residual   : vocals + instrumental - mix, in dBFS (must be ~-inf: instrumental is
                 defined as mix - vocals, so this validates the OLA bookkeeping only)
  * sum4       : drums+bass+other+vocals vs mix in dB. This is a property of Demucs,
                 typically 20-30 dB. It does NOT validate stem order (sum is commutative).
"""

import argparse
import json
import sys
import wave

import numpy as np


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 2 or w.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit stereo")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    return a.reshape(-1, 2), sr


def db(x, floor=1e-12):
    return 20.0 * np.log10(max(float(x), floor))


def band_ratios(x, sr):
    """Energy fraction in low / vocal / high bands, from the average magnitude spectrum."""
    mono = x.mean(axis=1)
    n = 1 << 15
    if len(mono) > n:
        start = (len(mono) - n) // 2  # centre chunk: avoid the OLA edges
        mono = mono[start:start + n]
    else:
        mono = np.pad(mono, (0, n - len(mono)))
    spec = np.abs(np.fft.rfft(mono * np.hanning(len(mono)))) ** 2
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    total = spec.sum() + 1e-20

    def frac(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(spec[m].sum() / total)

    centroid = float((freqs * spec).sum() / total)
    return {
        "centroid_hz": round(centroid, 1),
        "frac_lt250": round(frac(0, 250), 4),
        "frac_250_4k": round(frac(250, 4000), 4),
        "frac_gt4k": round(frac(4000, sr / 2), 4),
    }


def describe(name, x):
    mono = x.mean(axis=1)
    rms = float(np.sqrt(np.mean(mono ** 2)))
    peak = float(np.max(np.abs(x)))
    return {
        "name": name,
        "rms_dbfs": round(db(rms), 2),
        "peak": round(peak, 4),
        "crest_db": round(db(peak / rms) if rms > 0 else 0.0, 2),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mix", required=True, help="the 30 s input wav")
    ap.add_argument("--dir", required=True, help="output dir holding vocals.wav / instrumental.wav [/stems]")
    ap.add_argument("--stems4", nargs="*", default=None, help="optional drums.wav bass.wav other.wav vocals4.wav")
    ap.add_argument("--json", default=None, help="write the summary here")
    ap.add_argument("--gain", type=float, default=1.0,
                    help="headroom gain the prototype applied to both stems before int16 write; "
                         "the residual is computed after dividing it back out")
    a = ap.parse_args()

    mix, sr = read_wav(a.mix)
    voc, _ = read_wav(a.dir + "/vocals.wav")
    ins, _ = read_wav(a.dir + "/instrumental.wav")
    if a.gain and a.gain != 1.0:
        voc = voc / a.gain
        ins = ins / a.gain

    n = min(len(mix), len(voc), len(ins))
    mix, voc, ins = mix[:n], voc[:n], ins[:n]

    out = {"sample_rate": sr, "frames": n, "seconds": round(n / sr, 3)}

    # 1. exactness of instrumental = mix - vocals
    resid = voc + ins - mix
    out["residual_dbfs"] = round(db(float(np.sqrt(np.mean(resid ** 2)))), 2)

    out["mix"] = describe("mix", mix)
    for name, x in (("vocals", voc), ("instrumental", ins)):
        d = describe(name, x)
        d.update(band_ratios(x, sr))
        out[name] = d

    # 2. crude "did the vocal actually leave the accompaniment" metric:
    #    energy change of instrumental vs mix inside the vocal band
    def band_energy(x, lo, hi):
        mono = x.mean(axis=1)
        spec = np.abs(np.fft.rfft(mono)) ** 2
        f = np.fft.rfftfreq(len(mono), 1.0 / sr)
        return float(spec[(f >= lo) & (f < hi)].sum())

    for lo, hi in ((200, 4000), (80, 250), (4000, 16000)):
        e_mix = band_energy(mix, lo, hi)
        e_ins = band_energy(ins, lo, hi)
        out.setdefault("band_change_mix_to_instrumental_db", {})[f"{lo}-{hi}"] = round(
            10.0 * np.log10(max(e_ins, 1e-20) / max(e_mix, 1e-20)), 2)

    # 3. four-stem order check + reconstruction
    if a.stems4:
        stems = {p.split("/")[-1].removesuffix(".wav"): read_wav(p)[0][:n] for p in a.stems4}
        rows = []
        for name in ("drums", "bass", "other", "vocals4"):
            if name not in stems:
                continue
            d = describe(name, stems[name])
            d.update(band_ratios(stems[name], sr))
            rows.append(d)
        out["stems"] = rows

        s4 = sum(stems[k] for k in ("drums", "bass", "other", "vocals4") if k in stems)
        err = s4 - mix
        out["sum4_minus_mix_db"] = round(db(float(np.sqrt(np.mean(err.mean(axis=1) ** 2)))), 2)

        # expected signature table — helps a human confirm the ordering at a glance
        out["order_expectation"] = {
            "bass": "frac_lt250 should dominate (>0.5), centroid < 300 Hz",
            "drums": "highest crest_db, frac_gt4k well above vocals",
            "vocals": "centroid ~500-1800 Hz, low crest_db",
            "other": "brightest, centroid typically highest",
        }

    txt = json.dumps(out, indent=2, ensure_ascii=False)
    print(txt)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            f.write(txt)


if __name__ == "__main__":
    sys.exit(main())
