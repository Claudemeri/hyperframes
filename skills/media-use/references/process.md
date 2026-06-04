# process

Transform an existing asset. The intent is usually explicit, which makes this a clean media-use job.

## Operations

`remove-background` · `matting` · `upscale` · `crop` · `trim` · `normalize` (audio) · `transcribe` · `extract-alpha`

## Free-first (today)

- **background removal:** `npx hyperframes remove-background ...` (local). Note: `--background-output` is hole-cut, not inpainted — for "scene without the person" a different tool is needed (see `/hyperframes-media`).
- **transcribe:** `npx hyperframes transcribe --model <m> ...`.

## Procedure

```
process --asset img_001 --action remove-bg
```

1. run the underlying tool (free/local first; see `provider-routing.md`)
2. write the output into `assets/processed/`
3. register a new AssetRecord with `source: "processed"` and `provenance.derived_from: "img_001"`
4. regenerate `index.md`

## Paid / heavy [later]

HQ matting / upscale / A-roll are GPU-heavy → route to the key-gated provider when available; otherwise a local rough version, or skip-with-report. These are the monetizable capabilities that come after the free wedge.
