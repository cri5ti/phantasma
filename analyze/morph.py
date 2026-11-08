"""Offline face/body morph between two stills of the same character, driven by optical flow (RAFT).

A scene shader can't solve occlusions or invert a flow field cheaply per pixel, so the in-betweens are rendered here
once and packed into texture atlases. The scene then only picks (and cross-fades) frames from a `morph` param.

usage (from mvgen/, with the flow venv — see below):
  .venv-flow/bin/python analyze/morph.py "<project dir>" --b stock/motion1.png [--frames 24] [--name motion1]
      [--a stock/dif1.png --a-lit stock/dif2.png --matte stock/char-matte.png --bg stock/dif1-bg.png]
      [--grade 1.0] [--iters 24] [--force]

  A        the plate (the scene's starting look), with --a-lit its lit variant (same framing) and --matte its matte
  B        an RGBA cut-out of the target pose, any size/framing — it is fitted onto A's silhouette (scale, rotation,
           offset) automatically
  out      <project>/_mvgen/morph/<name>/  plate.jpg, lit.jpg, matte.png (atlases), morph.json (layout), debug/
           flow is cached in flow.npz (delete it, or --force, to recompute)

Steps: fit B onto A → RAFT flow A→B and B→A (on a contrast-normalised luma, so the different lighting of the two
stills matters less) → per frame t, softmax-splat A's pixels forward by t·F_AB and B's by (1−t)·F_BA into one
buffer (character beats background, flow-consistent pixels beat inconsistent ones), fill the few holes.
B gets A's lighting (colour-matched to the plate, the lit variant through the lit/plate ratio carried along the flow).

Setup (once, from mvgen/):
  python3.12 -m venv .venv-flow && .venv-flow/bin/pip install torch torchvision scipy pillow
  the RAFT weights (~21 MB) download on first use; if Python's SSL fails, fetch them with curl into
  ~/.cache/torch/hub/checkpoints/raft_large_C_T_SKHT_V2-ff5fadd5.pth
"""
import argparse
import json
import math
import os
import time

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy import optimize


def load_rgb(path, size=None):
    im = Image.open(path).convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255


def load_l(path, size=None):
    im = Image.open(path).convert("L")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255


def save(path, a, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), mode)
    if path.endswith(".jpg"):
        im.save(path, quality=94, subsampling=0)
    else:
        im.save(path, optimize=True)


# ---- fitting B onto A ------------------------------------------------------------------------------------------
def similarity_warp(img, s, r, tx, ty, shape, order=1):
    """B → plate: p = s·R(r)·b + t. Samples B at the inverse for every plate pixel."""
    c, si = math.cos(r), math.sin(r)
    M = np.array([[c, si], [-si, c]]) / s
    Mrc = np.array([[M[1, 1], M[1, 0]], [M[0, 1], M[0, 0]]])
    o = -Mrc @ np.array([ty, tx])
    if img.ndim == 2:
        return ndi.affine_transform(img, Mrc, o, output_shape=shape, order=order, cval=0)
    return np.dstack([ndi.affine_transform(img[..., k], Mrc, o, output_shape=shape, order=order, cval=0)
                      for k in range(img.shape[2])])


def fit_b(MA, MB):
    H, W = MA.shape
    ys, xs = np.where(MA > 0.5)
    ysb, xsb = np.where(MB > 0.5)
    # initial guess: match silhouette widths at the shoulders and the top of the heads
    s0 = (np.percentile(xs, 98) - np.percentile(xs, 2)) / (np.percentile(xsb, 98) - np.percentile(xsb, 2))
    # the heads may differ, so weigh the body more
    top = ys.min()
    wgt = np.zeros((H, W), np.float32)
    wgt[int(top + 0.35 * (H - top)):, :] = 1
    wgt[top:int(top + 0.35 * (H - top)), :] = 0.3
    MAs = ndi.gaussian_filter(MA, 4)
    MBs = ndi.gaussian_filter(MB, 4 / s0)
    ones = np.ones_like(MB)

    def cost(v):
        s, r, tx, ty = v
        m = similarity_warp(MBs, s, r, tx, ty, (H, W))
        valid = similarity_warp(ones, s, r, tx, ty, (H, W), order=0) > 0.5   # B may be cut off at its edges
        w = wgt * valid
        cov = w.sum() / (wgt.sum() + 1)
        return ((m - MAs) ** 2 * w).sum() / (w.sum() + 1) + 0.5 * max(0.0, 0.6 - cov)

    best = None
    for ds in (0.9, 1.0, 1.1):
        for dr in (-0.08, 0.0, 0.08):
            s = s0 * ds
            tx = xs.mean() - s * xsb.mean()
            ty = top - s * ysb.min()
            r = optimize.minimize(cost, [s, dr, tx, ty], method="Powell",
                                  bounds=[(s0 * 0.6, s0 * 1.5), (-0.4, 0.4), (-W, 2 * W), (-H, 2 * H)],
                                  options={"xtol": 1e-3, "ftol": 1e-6})
            if best is None or r.fun < best.fun:
                best = r
    return [float(v) for v in best.x], float(best.fun)


# ---- flow ------------------------------------------------------------------------------------------------------
def flow_prep(rgb, matte):
    """Contrast-normalised luma: removes most of the lighting difference between the stills, keeps the features."""
    g = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    mu = ndi.gaussian_filter(g, 12)
    sd = np.sqrt(ndi.gaussian_filter((g - mu) ** 2, 12)) + 0.02
    n = np.clip((g - mu) / sd, -2.5, 2.5) / 5 + 0.5
    n = 0.75 * n + 0.25 * matte                      # keep the silhouette as a strong cue
    return np.repeat(n[..., None], 3, -1)


def raft_flows(imA, imB, iters, log):
    import torch
    from torchvision.models.optical_flow import Raft_Large_Weights, raft_large

    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model = raft_large(weights=Raft_Large_Weights.C_T_SKHT_V2).eval().to(dev)
    H, W = imA.shape[:2]
    ph, pw = (-H) % 8, (-W) % 8

    def tens(a):
        a = np.pad(a, ((0, ph), (0, pw), (0, 0)), mode="edge")
        return (torch.from_numpy(a).permute(2, 0, 1)[None] * 2 - 1).float().to(dev)

    tA, tB = tens(imA), tens(imB)
    out = []
    with torch.no_grad():
        for a, b, name in ((tA, tB, "A→B"), (tB, tA, "B→A")):
            t0 = time.time()
            f = model(a, b, num_flow_updates=iters)[-1][0].permute(1, 2, 0).cpu().numpy()[:H, :W]
            log(f"  flow {name}: {time.time() - t0:.1f}s, |f| max {np.abs(f).max():.0f}px, mean {np.linalg.norm(f, axis=-1).mean():.1f}px")
            out.append(f)
    return out


def sample(img, x, y):
    """bilinear sample img (h,w[,c]) at float pixel coords x, y (same shape)."""
    if img.ndim == 2:
        return ndi.map_coordinates(img, [y, x], order=1, mode="nearest")
    return np.stack([ndi.map_coordinates(img[..., k], [y, x], order=1, mode="nearest") for k in range(img.shape[2])], -1)


def fill_holes(acc, wsum):
    """normalised convolution at growing radii for pixels nothing was splatted onto."""
    out = acc / np.maximum(wsum, 1e-8)[..., None]
    hole = wsum < 1e-6
    if not hole.any():
        return out
    have = (~hole).astype(np.float32)
    v = out * have[..., None]
    for s in (1, 2, 4, 8, 16):
        den = ndi.gaussian_filter(have, s)
        num = np.stack([ndi.gaussian_filter(v[..., k], s) for k in range(v.shape[-1])], -1)
        take = hole & (den > 1e-3)
        out[take] = num[take] / den[take][..., None]
        hole &= ~take
        if not hole.any():
            break
    return out


def splat(h, w, xs, ys, vals, wts):
    """bilinear forward splat of vals (N,C) with weights (N,) to positions xs, ys."""
    C = vals.shape[1]
    acc = np.zeros((h * w, C), np.float64)
    wsum = np.zeros(h * w, np.float64)
    x0, y0 = np.floor(xs).astype(np.int64), np.floor(ys).astype(np.int64)
    fx, fy = xs - x0, ys - y0
    for dx, dy, k in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        xi, yi = x0 + dx, y0 + dy
        ok = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
        idx = yi[ok] * w + xi[ok]
        ww = (wts * k)[ok]
        wsum += np.bincount(idx, ww, h * w)
        for c in range(C):
            acc[:, c] += np.bincount(idx, ww * vals[ok, c], h * w)
    return acc.reshape(h, w, C), wsum.reshape(h, w)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--b", required=True)
    ap.add_argument("--a", default="stock/dif1.png")
    ap.add_argument("--a-lit", default="stock/dif2.png")
    ap.add_argument("--matte", default="stock/char-matte.png")
    ap.add_argument("--bg", default="stock/dif1-bg.png")
    ap.add_argument("--name", default=None)
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--grade", type=float, default=1.0, help="0 = keep B's colours, 1 = match the plate's")
    ap.add_argument("--iters", type=int, default=24, help="RAFT refinement iterations")
    ap.add_argument("--pad", type=int, default=48, help="px around the union of both silhouettes")
    ap.add_argument("--force", action="store_true")
    o = ap.parse_args()

    P = o.project
    name = o.name or os.path.splitext(os.path.basename(o.b))[0]
    out = os.path.join(P, "_mvgen", "morph", name)
    os.makedirs(os.path.join(out, "debug"), exist_ok=True)
    t_start = time.time()
    log = lambda m: print(f"[{time.time() - t_start:6.1f}s] {m}", flush=True)

    A = load_rgb(os.path.join(P, o.a))
    H, W = A.shape[:2]
    A2 = load_rgb(os.path.join(P, o.a_lit), (W, H))
    MA = load_l(os.path.join(P, o.matte), (W, H))
    BG = load_rgb(os.path.join(P, o.bg), (W, H))
    Bimg = np.asarray(Image.open(os.path.join(P, o.b)).convert("RGBA")).astype(np.float32) / 255

    opaque = Bimg[..., 3].min() > 0.98
    bh, bw = Bimg.shape[:2]
    if opaque:
        # a full frame (not a cut-out): it must share A's framing; its matte is derived (see derive_matte)
        if abs(bw / bh - W / H) > 0.01:
            raise SystemExit(f"{o.b} is opaque and framed differently from {o.a} ({bw}×{bh} vs {W}×{H}): "
                             "give a cut-out (RGBA) instead, so it can be fitted")
        Brgb = load_rgb(os.path.join(P, o.b), (W, H))
        mpath = os.path.join(out, "b-matte.png")
        if os.path.exists(mpath) and not o.force:
            MB = load_l(mpath, (W, H))
            log(f"B matte: {mpath} (cached — edit it by hand if needed, --force re-derives it)")
        else:
            log("B is a full frame → deriving its matte from A's (flow) + the clean background …")
            MB = derive_matte(A, Brgb, BG, MA, o.iters, log)
            save(mpath, MB, "L")
        cover = np.ones((H, W), np.float32)
    else:
        Brgb, MB, cover = fit_cutout(o, out, Bimg, MA, W, H, log)

    # where B doesn't reach (cut off at its border) keep A
    MB = MB * cover + MA * (1 - cover)
    # 2. grade B to the plate (per-channel mean/std over the shared character area)
    both = (MA > 0.9) & (MB > 0.9) & (cover > 0.99)
    Bg = Brgb.copy()
    for c in range(3):
        a, b = A[..., c][both], Brgb[..., c][both]
        Bg[..., c] = (Brgb[..., c] - b.mean()) * (a.std() / max(b.std(), 1e-4)) + a.mean()
    Bg = np.clip(Brgb + o.grade * (Bg - Brgb), 0, 1)
    B1 = Bg * MB[..., None] + BG * (1 - MB[..., None])
    B1 = B1 * cover[..., None] + A * (1 - cover[..., None])

    # 3. crop to everything that changes
    U = ndi.binary_dilation((MA > 0.05) | (MB > 0.05), iterations=o.pad)
    ys, xs = np.where(U)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    cw, ch = x1 - x0, y1 - y0
    log(f"crop: x {x0}..{x1}, y {y0}..{y1} ({cw}×{ch})")
    crop = lambda a: a[y0:y1, x0:x1]
    cA, cA2, cMA, cB1, cMB = map(crop, (A, A2, MA, B1, MB))
    run_morph(o, P, out, log, A, BG, W, H, cA, cA2, cMA, cB1, cMB, crop, x0, y0, x1, y1, cw, ch)


def guided_filter(I, p, r, eps):
    """He et al. guided filter (grey guide): snaps the soft matte p to the edges of I."""
    box = lambda a: ndi.uniform_filter(a, 2 * r + 1)
    mI, mp = box(I), box(p)
    a = (box(I * p) - mI * mp) / (box(I * I) - mI * mI + eps)
    b = mp - a * mI
    return box(a) * I + box(b)


def derive_matte(A, B, BG, MA, iters, log):
    """Matte for a full-frame B with A's framing: A's matte carried along the B→A flow (the character keeps its
    shape as it moves), minus what has become background (B differs from A there but matches the clean plate),
    snapped to B's edges."""
    H, W = MA.shape
    U = ndi.binary_dilation(MA > 0.05, iterations=160)
    ys, xs = np.where(U)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    c = lambda a: a[y0:y1, x0:x1]
    cA, cB, cBG, cMA = map(c, (A, B, BG, MA))
    z = np.zeros_like(cMA)
    _, fBA = raft_flows(flow_prep(cA, z), flow_prep(cB, z), iters, log)
    h, w = cMA.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pr = sample(cMA, xx + fBA[..., 0], yy + fBA[..., 1])
    g = lambda a: ndi.gaussian_filter(a, (2, 2, 0))
    ss = lambda x, a, b: (lambda t: t * t * (3 - 2 * t))(np.clip((x - a) / (b - a), 0, 1))
    dA = np.abs(g(cB) - g(cA)).max(-1)
    dBG = np.abs(g(cB) - g(cBG)).max(-1)
    revealed = pr * ss(dA, 0.03, 0.07) * (1 - ss(dBG, 0.015, 0.04))
    m = np.clip(pr - revealed, 0, 1)
    m = ndi.binary_fill_holes(m > 0.5).astype(np.float32) * 0.5 + m * 0.5     # no pin-holes inside
    gray = cB @ np.array([0.299, 0.587, 0.114], np.float32)
    m = np.clip(guided_filter(gray, m, 6, 2e-3), 0, 1)
    out = np.zeros((H, W), np.float32)
    out[y0:y1, x0:x1] = m
    log(f"  matte: {(out > 0.5).sum() / max((MA > 0.5).sum(), 1):.2f}× A's area")
    return out


def fit_cutout(o, out, Bimg, MA, W, H, log):
    """Fit an RGBA cut-out onto A's silhouette → (straight colour, alpha, coverage) in A's frame."""
    fit_path = os.path.join(out, "fit.json")
    if os.path.exists(fit_path) and not o.force:
        fit = json.load(open(fit_path))
    else:
        log("fitting B onto A's silhouette …")
        # fit at half resolution (it's a silhouette match), then scale back up
        mA = np.asarray(Image.fromarray((MA * 255).astype(np.uint8)).resize((W // 2, H // 2), Image.BILINEAR)).astype(np.float32) / 255
        bh, bw = Bimg.shape[:2]
        mB = np.asarray(Image.fromarray((Bimg[..., 3] * 255).astype(np.uint8)).resize((bw // 2, bh // 2), Image.BILINEAR)).astype(np.float32) / 255
        v, err = fit_b(mA, mB)
        v = [v[0] * ((bw // 2) / bw) * (W / (W // 2)), v[1], v[2] * W / (W // 2), v[3] * H / (H // 2)]
        fit = dict(zip(["scale", "rotation", "tx", "ty"], v), error=err, b=o.b)
        json.dump(fit, open(fit_path, "w"), indent=1)
    log(f"fit: scale {fit['scale']:.4f}, rotation {math.degrees(fit['rotation']):.2f}°, offset ({fit['tx']:.1f}, {fit['ty']:.1f})")
    Bw = similarity_warp(Bimg, fit["scale"], fit["rotation"], fit["tx"], fit["ty"], (H, W))
    # premultiplied → straight colour, and B's coverage of the frame (it may be cut off)
    MB = Bw[..., 3]
    cover = similarity_warp(np.ones(Bimg.shape[:2], np.float32), fit["scale"], fit["rotation"], fit["tx"], fit["ty"], (H, W), order=0)
    cover = ndi.gaussian_filter(ndi.binary_erosion(cover > 0.5, iterations=4).astype(np.float32), 3)
    Brgb = Bw[..., :3] / np.maximum(MB, 1e-3)[..., None] * (MB > 1e-3)[..., None]
    return Brgb, MB, cover


def run_morph(o, P, out, log, A, BG, W, H, cA, cA2, cMA, cB1, cMB, crop, x0, y0, x1, y1, cw, ch):
    # 4. flows
    flow_path = os.path.join(out, "flow.npz")
    if os.path.exists(flow_path) and not o.force:
        f = np.load(flow_path)
        fAB, fBA = f["ab"], f["ba"]
        log("flow: cached")
    else:
        log(f"RAFT flow on {cw}×{ch} …")
        fAB, fBA = raft_flows(flow_prep(cA, cMA), flow_prep(cB1, cMB), o.iters, log)
        np.savez_compressed(flow_path, ab=fAB, ba=fBA)

    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    # forward-backward consistency (px): small where the correspondence is trustworthy
    cAB = np.linalg.norm(fAB + sample(fBA, xx + fAB[..., 0], yy + fAB[..., 1]), axis=-1)
    cBA = np.linalg.norm(fBA + sample(fAB, xx + fBA[..., 0], yy + fBA[..., 1]), axis=-1)
    log(f"consistency: A→B median {np.median(cAB[cMA > 0.5]):.1f}px, B→A median {np.median(cBA[cMB > 0.5]):.1f}px")

    # B's lit variant: the light the lit plate adds (lit − plate, softened), carried along the flow onto B.
    # Additive, not a ratio: a per-channel ratio explodes on near-black cloth (the coat went green).
    delta = ndi.gaussian_filter(cA2, (5, 5, 0)) - ndi.gaussian_filter(cA, (5, 5, 0))
    deltaB = sample(delta, xx + fBA[..., 0], yy + fBA[..., 1])
    cB2 = np.clip(cB1 + deltaB, 0, 1)
    # outside the character the lit plate is the lit background — use the A2 background as is
    bgL = crop(load_rgb(os.path.join(P, "stock", "dif2-bg.png"), (W, H))) if os.path.exists(os.path.join(P, "stock", "dif2-bg.png")) else cA2
    cB2 = cB2 * cMB[..., None] + bgL * (1 - cMB[..., None])

    # debug: B warped back onto A with the flow (should look like A's pose)
    save(os.path.join(out, "debug", "B_on_A.jpg"), sample(cB1, xx + fAB[..., 0], yy + fAB[..., 1]))
    save(os.path.join(out, "debug", "A_on_B.jpg"), sample(cA, xx + fBA[..., 0], yy + fBA[..., 1]))
    save(os.path.join(out, "debug", "A.jpg"), cA)
    save(os.path.join(out, "debug", "B.jpg"), cB1)

    # 5. frames: softmax splat of both sources into one buffer
    N = o.frames
    va = np.concatenate([cA, cA2, cMA[..., None]], -1).reshape(-1, 7)
    vb = np.concatenate([cB1, cB2, cMB[..., None]], -1).reshape(-1, 7)
    zA = (6 * cMA - 0.25 * np.minimum(cAB, 24)).reshape(-1)       # character in front; trust consistent flow
    zB = (6 * cMB - 0.25 * np.minimum(cBA, 24)).reshape(-1)
    zm = max(zA.max(), zB.max())
    eA, eB = np.exp(zA - zm), np.exp(zB - zm)
    fa, fb = fAB.reshape(-1, 2), fBA.reshape(-1, 2)
    px, py = xx.reshape(-1), yy.reshape(-1)
    frames = []
    for i in range(N):
        t = i / (N - 1)
        if i == 0:
            fr = np.concatenate([cA, cA2, cMA[..., None]], -1)
        elif i == N - 1:
            fr = np.concatenate([cB1, cB2, cMB[..., None]], -1)
        else:
            # time weights: smooth hand-over, so each source dominates its own half
            wa, wb = (1 - t) ** 2, t ** 2
            acc1, w1 = splat(ch, cw, px + t * fa[:, 0], py + t * fa[:, 1], va, eA * wa)
            acc2, w2 = splat(ch, cw, px + (1 - t) * fb[:, 0], py + (1 - t) * fb[:, 1], vb, eB * wb)
            fr = fill_holes(acc1 + acc2, w1 + w2).astype(np.float32)
        frames.append(fr)
        log(f"frame {i + 1}/{N} (t={t:.3f})")

    # 6. atlases
    cols = max(1, round(math.sqrt(N * ch / cw)))
    rows = math.ceil(N / cols)
    while cols * cw > 16384 or rows * ch > 16384:
        raise SystemExit("atlas too big for a GPU texture — use fewer --frames")
    atl = np.zeros((rows * ch, cols * cw, 7), np.float32)
    for i, fr in enumerate(frames):
        r, c = divmod(i, cols)
        atl[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = fr
    save(os.path.join(out, "plate.jpg"), atl[..., 0:3])
    save(os.path.join(out, "lit.jpg"), atl[..., 3:6])
    save(os.path.join(out, "matte.png"), atl[..., 6], "L")
    for i in (0, N // 4, N // 2, 3 * N // 4, N - 1):
        fr = frames[i]
        save(os.path.join(out, "debug", f"frame{i:02d}.jpg"), fr[..., :3] * fr[..., 6:7] + crop(BG) * (1 - fr[..., 6:7]))
    x0, y0, x1, y1, cw, ch = map(int, (x0, y0, x1, y1, cw, ch))
    meta = dict(frames=N, cols=cols, rows=rows, tile=[cw, ch], plate=[W, H],
                crop=[int(x0), int(y0), int(cw), int(ch)],
                # crop rect in plate uv with the origin bottom-left, as the scene shader uses it
                cropUv=[x0 / W, 1 - y1 / H, cw / W, ch / H])
    json.dump(meta, open(os.path.join(out, "morph.json"), "w"), indent=1)
    log(f"done → {out}  ({cols}×{rows} atlas of {cw}×{ch}); cropUv {[round(v, 5) for v in meta['cropUv']]}")


if __name__ == "__main__":
    main()
