"""Faithful CPU replication of @imgly/background-removal@1.7.0's pipeline.

Same isnet_fp16 ONNX weights the browser package downloads, same preprocessing
(stretch to 1024x1024, (x-128)/256, BCHW), same postprocessing (alpha*255,
bilinear rescale back to source size). The point is to judge output quality
without a browser, so every step here mirrors dist/index.mjs rather than doing
whatever the local libraries make easy.
"""
import sys, time, json
import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = '/tmp/isnet_fp16.onnx'
RES = 1024

_sess = None


def session():
    global _sess
    if _sess is None:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _sess = ort.InferenceSession(MODEL, opts, providers=['CPUExecutionProvider'])
    return _sess


def remove_background(path):
    src = Image.open(path).convert('RGBA')
    w, h = src.size

    # keepAspect = false in runInference: a plain stretch to a square.
    resized = src.resize((RES, RES), Image.BILINEAR)
    arr = np.asarray(resized, dtype=np.float32)          # HWC RGBA
    chw = (arr[:, :, :3] - 128.0) / 256.0                # tensorHWCtoBCHW defaults
    inp = np.transpose(chw, (2, 0, 1))[None].astype(np.float32)

    s = session()
    t0 = time.perf_counter()
    out = s.run([s.get_outputs()[0].name], {s.get_inputs()[0].name: inp})[0]
    infer_ms = (time.perf_counter() - t0) * 1000

    alpha = np.asarray(out).reshape(RES, RES)
    alpha_u8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    alpha_full = np.asarray(
        Image.fromarray(alpha_u8, 'L').resize((w, h), Image.BILINEAR)
    )

    cut = np.dstack([np.asarray(src)[:, :, :3], alpha_full])
    return Image.fromarray(cut, 'RGBA'), alpha_full, infer_ms


def alpha_stats(a):
    total = a.size
    fg = int((a > 250).sum())
    bg = int((a < 5).sum())
    soft = total - fg - bg
    return {
        'fg_pct': round(100 * fg / total, 2),
        'bg_pct': round(100 * bg / total, 2),
        'soft_edge_pct': round(100 * soft / total, 2),
    }


if __name__ == '__main__':
    import pathlib
    outdir = pathlib.Path('/tmp/qa/out')
    outdir.mkdir(parents=True, exist_ok=True)
    results = []
    for p in sorted(pathlib.Path('/tmp/qa/in').glob('*.jpg')):
        img, alpha, ms = remove_background(p)
        img.save(outdir / f'{p.stem}_cutout.png')
        Image.fromarray(alpha, 'L').save(outdir / f'{p.stem}_alpha.png')
        r = {'image': p.stem, 'size': f'{img.width}x{img.height}',
             'infer_ms': round(ms), **alpha_stats(alpha)}
        results.append(r)
        print(json.dumps(r))
    json.dump(results, open('/tmp/qa/results.json', 'w'), indent=1)
