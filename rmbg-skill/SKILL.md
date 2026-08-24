---
name: rmbg-background-removal
version: 1.0.0
description: Remove the background from an image handed off by the rmbg Cloudflare Worker (https://rmbg.zack-chen.workers.dev) over A2A. Use this whenever an incoming A2A message's text part contains an input URL, an upload URL, and a job token for background removal — that shape of request is always this job, never anything else. Produces a real RGBA cutout via gemini-3.1-flash-image plus a local chroma-key step; never returns SVG, a mask, or prose in place of pixels.
---

# rmbg background removal

You remove backgrounds from images for the rmbg Worker, using the Gemini API
**image-generation** model **`gemini-3.1-flash-image`** (Nano Banana 2), called via
`generateContent`. One image per request, no conversation. Nobody reads your prose — your
reply is consumed by a program, so it only needs a final `DONE` or an honest failure message.

## The image does not travel over A2A

Your agent card declares `defaultOutputModes: ["text/plain"]`. You cannot attach a file
artifact, and a real PNG is far too large to spell out as base64 in a chat reply. The bytes of
an A2A file part never land on your filesystem either. So the image moves over **HTTP, through
R2** — not through the conversation. The incoming message's file part is only there so you can
*see* the subject; the input URL in the text part is the authoritative copy to actually process.

The **upload is the delivery channel**, not your reply text. The Worker answers its caller
immediately and watches R2 for your upload, so a successful `PUT` finishes the job even if the
A2A stream has already dropped and your reply reaches nobody. Never abandon a turn because the
connection looks dead — upload anyway. Conversely, replying "done" without a successful `PUT`
delivers nothing.

## What arrives

An A2A message with a file part (the image, for context only) and a text part naming the
**input URL**, the **upload URL**, and a **job token**, generated fresh per request.

## Procedure

```bash
# 1. Download the real bytes.
curl -sS -o /tmp/input.png '<input URL>'
```

**Step 2 — ask `gemini-3.1-flash-image` for a flat magenta background, not for transparency.**
Save its output as `/tmp/gen.png`.

This is the single most important instruction here, and it is counter-intuitive. An image
generator has no alpha channel to write to. Asked for a transparent background it will do the
only thing it can: *paint a picture of transparency* — a grey-and-white checkerboard — as
ordinary opaque pixels. Ask for something it can actually produce instead:

> the same image, with every background pixel replaced by solid pure magenta, RGB exactly
> (255, 0, 255) — one flat colour, no gradient, no shadow, no vignette, no texture

Keep the subject's own pixels: colours, texture, hair, fur, edge detail, proportions. Do not
restyle, recolour, crop or recompose it. If the subject itself contains magenta, use pure green
(0, 255, 0) and key on that colour instead in step 3.

**Step 3 — convert that flat colour into a real alpha channel, back at the original size.**
This step, not Gemini, is what produces the transparency. It also suppresses colour spill:
semi-transparent edge pixels are an anti-aliased blend of subject and key colour, so the key
colour is un-mixed back out of them rather than left as a magenta fringe.

```bash
python3 - <<'EOF'
from PIL import Image
import numpy as np
src = Image.open('/tmp/input.png').convert('RGB')
gen = Image.open('/tmp/gen.png').convert('RGB').resize(src.size, Image.LANCZOS)
rgb = np.array(gen).astype(np.float32)
key = np.array([255, 0, 255], dtype=np.float32)   # match the colour asked for in step 2
dist = np.abs(rgb - key).sum(axis=2)
alpha = np.clip((dist - 60) * 4, 0, 255).astype(np.uint8)
a = (alpha.astype(np.float32) / 255.0)[..., None]
decontam = np.clip((rgb - key * (1 - a)) / np.clip(a, 1e-3, 1), 0, 255)
rgb_out = np.where(alpha[..., None] < 255, decontam, rgb).astype(np.uint8)
Image.fromarray(np.dstack([rgb_out, alpha]), 'RGBA').save('/tmp/output.png')
EOF
```

With ImageMagick instead (no spill suppression, use only if PIL/numpy are unavailable):

```bash
convert /tmp/gen.png -resize "$(identify -format '%wx%h!' /tmp/input.png)" \
  -fuzz 20% -transparent magenta /tmp/output.png
```

If neither tool exists, do not improvise and do not upload — say so in your reply.

```bash
# 4. Upload the result.
curl -sS -X PUT --data-binary @/tmp/output.png \
  -H 'content-type: image/png' \
  -H 'x-job-token: <job token>' \
  '<upload URL>'
```

A `200` from step 4 means it landed. Then reply with the single word `DONE`.

The token expires in ten minutes. A *rejected* upload does not spend it, so if the Worker
answers `502` you can fix the file and PUT again with the same token. Once an upload is
accepted the token is spent, and a further PUT returns `409` — correct, not something to work
around.

## What the Worker rejects

Checked on the bytes, not on the content-type header you send:

- **A JPEG.** JPEG has no alpha channel in any variant, so it cannot be a cutout. `502`.
- **A PNG with no alpha channel** — IHDR colour type 2 or 0. `502`.
- **Anything under 16 pixels on an edge** — the 1×1 placeholder. `502`.
- Output dimensions should equal input dimensions; the step 3 script handles that.

## The one rule that matters most

**Never upload a placeholder.** Never a 1×1 PNG, never a blank or fully transparent canvas,
never a stand-in "example" image, never the input returned unchanged, never a base64 string you
reproduced from memory rather than produced from this input.

This has actually happened twice in production: once as the well-known 68-byte 1×1 transparent
PNG when a malformed A2A part meant no image ever arrived, and once as an 848 KB **JPEG**
containing a hand-drawn checkerboard, mechanically a "success" but not a cutout — which is why
step 2 asks for magenta and step 3 does the keying rather than trusting the model for alpha
directly.

**An honest failure is strictly better.** If any step fails, reply in plain text naming the
command that failed and what it printed. The Worker surfaces that text to the caller. It cannot
surface a problem you disguised as success.

## Do not

- Do not paste base64 into your reply. The upload is the delivery channel, not your reply.
- Do not return SVG, a JSON polygon, a mask path, or coordinates. Pixels only.
- Do not describe what you would do, or narrate a plan. Run the commands.
- Do not ask clarifying questions. There is nobody to answer them; the request will time out.
- Do not say the image is missing. If the file part looks empty, ignore it — the input URL is
  the authoritative copy, and it is always there.

## If you cannot do this at all

Say so, in plain text, on the first request — for example if you have no outbound network, no
shell, or `gemini-3.1-flash-image` 404s / is not available on your key. A plain `-flash` or
`-pro` Gemini model is text-only and cannot do step 2; do not silently substitute one. That
answer is genuinely useful: it tells the operator which capability to add. Silently producing
something image-shaped, or silently falling back to a text model, wastes everyone's time.
