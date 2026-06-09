---
name: embedded-captions
description: 'Add captions to a talking-head video. Two modes — **Standard** (default): a clean verbatim lower-third RAIL carries the transcript plus an EMBED climax composited behind the subject at the peak; **Cinematic**: pure embed — every caption composited INTO the scene behind the subject (matte occlusion + mix-blend). Most explainer / voiceover is Standard; embedding every word is wrong for most talking-head content. Use when the user asks for "captions / subtitles", "embed/embedded/cinematic captions", "embed captions into the scene", "captions behind the subject", or similar. Pipeline: transcription → RVM matting → hyperframes HTML render → ffmpeg overlay. Requires hyperframes (github.com/heygen-com/hyperframes) and a single-subject clip.'
metadata:
  tags: captions, embedded-captions, occlusion, matting, talking-head, rvm, whisper, ffmpeg, cinematic
---

# Embedded Captions

**Two modes, picked up front.** **Standard** (default) builds a clean verbatim **rail** (lower-third subtitle carrying most text) + an **embed** climax composited *into* the scene behind the subject at the peak. **Cinematic** is pure embed — no rail, every caption composited behind the subject (hero typography, accumulation, occlusion as the effect). Most explainer / voiceover is **Standard**; **embed is the scarce, earned peak** — embedding every word is the common mistake.

---

## Operational flow (TL;DR)

The craft prose below is long; the **pipeline itself is short**:

1. **Decision gate** (refuse bad clips) → **pick mode** (Standard vs Cinematic)
2. `hyperframes init` → `matte.cjs` (subject matte) → `transcribe.cjs` (words)
3. **author**: Cinematic → write `plan.json` → `make-composition.cjs`; Standard → author `index.html` (embed) + `rail.html` (rail) from a chosen template
4. `render-and-composite.sh` → `final.mp4`

**Handoff.** `final.mp4` is the deliverable — report its path + duration. **`hyperframes preview` / `play` do NOT apply here**: the final is an ffmpeg composite of the rendered caption layers + RVM matte + the untouched footage, not a servable HyperFrames project, so previewing `index.html` / `rail.html` alone would not show the real result. No preview is surfaced during the run; to review, open `final.mp4` in a video player on request.

Load-bearing rules people miss:

- **rail (default) + embed (promotion).** `drop` (filler, not shown) / `rail` (verbatim lower-third subtitle, in front, carries most text) / `embed` (a peak word composited behind the subject). **Standard mode does both**, embedding only the peak(s). See **§ Caption model**.
- **The video is delivered UNTOUCHED** — captions are the only thing added; the matte just lets the subject occlude the embed track. Never grade/recolor/scanline the footage.
- Scripts auto-resolve `source.mp4` and the source's **native fps**; transcription uses hyperframes' **Whisper** (no API key) and falls back to an existing transcript.
- Two rulebooks: **rail → [references/rail.md](references/rail.md)** (thin), **embed craft → [references/composition-craft.md](references/composition-craft.md)** (rich, embed-only). Skim by need.

---

## Caption model — rail + embed

Every spoken phrase is one of three things:

| | What | How it's shown |
|---|---|---|
| **drop** | filler — um/uh, stutters, self-corrections | not shown |
| **rail** | the default — ordinary spoken content (verbatim) | clean lower-third subtitle, **in front**, readable. A punch word can get an inline `emphasis` highlight (accent colour / active-word pop) — it stays on the rail. |
| **embed** | a promoted peak — the headline beat | one big word composited **behind the subject** (matte occlusion), designed entrance + exit |

**The rail carries most of the text; embed is the scarce, earned peak** — ≤1 per beat, never two adjacent/co-visible, spaced ≥ a beat apart. A short clip → usually one embed; a long explainer → ~one per section. Embedding every word is the common mistake.

This is exactly what **Standard mode** builds (rail = `rail.html`, embed = the climax in `index.html`). **Cinematic mode** drops the rail and makes everything embed-style — use it only for pure-cinematic asks, never for explainer / voiceover where the words must read.

---

## Step 0 — pick the mode

**Mode is the user's choice — always present both options with your recommendation and let the user pick before you author.** Don't silently default. Probe the clip + content, recommend the fitting mode, state your pick + why in one line, then confirm with the user.

| Mode | What it is | Recommend it for | Author in |
|---|---|---|---|
| **Standard** (rail + embed) | a verbatim lower-third **rail** carries the whole transcript; only the peak(s) promote to an **embed** climax behind the subject | **explainer · voiceover / talking-head · interview · keynote · tutorial · product walkthrough · news · podcast clip** — anything where the spoken words must be fully read; accessibility; dense / information-heavy speech | [modes/standard/](modes/standard/) — 54-template library |
| **Cinematic** (pure embed) | **embed only** — no rail; every caption is composited into the scene behind the subject (hero typography, accumulation, occlusion as the effect) | **brand film · hype / teaser · social reel · music video · showcase · motivational · trailer** — short & punchy, few words, mood over comprehension; or the user says "make it cinematic / flashy / wow" or names a Cinematic template | [modes/template/](modes/template/) — `champion` · `cinematic-cream` · `memory-wall` · `portrait-header` |

**Recommendation heuristic** (you suggest, the user decides): dense speech / must-read words / longer clip → **Standard**; short, stylish, few words, mood over comprehension → **Cinematic**; bright backdrop (caption-region luminance > 180) → **Standard** (the cream/`screen` Cinematic templates wash out).

- **Standard** → read [modes/standard/PIPELINE.md](modes/standard/PIPELINE.md) (the contract — it overrides the library's `_anatomy.md` for this skill), pick the **3** templates that best fit the transcript (each file's `## Triggers`), then author `index.html` (embed climax) + `rail.html` (verbatim rail).
- **Cinematic** → write `plan.json` for a locked template, compiled by `make-composition.cjs`.

---

## Decision gate — RUN FIRST

Probe the video and classify the scene before either mode.

```bash
ffprobe <video.mp4>                    # specs
ffmpeg -ss <t> -i <video.mp4> -vframes 1 sample.png   # at 20/50/80%
```

Read the samples. Refuse if:
- Multiple speakers / hard cuts (split & render each shot, or refuse)
- No human subject (this skill is for talking-head)
- Under 3 seconds, no speech, or face never clearly visible
- Busy handheld with fast motion (matte flickers)

### Pre-flight probes (cost nothing, prevent the worst failures)

1. **Shot-cut probe.** Sample frames at 20%, 50%, 80%. If a different subject/scene appears, **trim the clip** before the cut.
2. **Letterbox / pillarbox probe.** Black bars on the first frame? Compute safe content rect and constrain caption placement inside it.
3. **Luminance probe.** Sample the caption region's average luminance — `under 60` → light text reads as-is, `60-180` → add the glyph scrim, `over 180` → opaque text + scrim (never bare light text). **Cinematic templates are cream+`screen` and LOCKED** — use this probe to *pick a fitting template* (or switch to Standard for bright scenes), never to recolour one; **Standard** you set in the HTML per the chosen template.
4. **Mode recommendation by tone (you recommend; the user picks — see Step 0).** **explainer / keynote / interview / voiceover → recommend Standard** (rail carries the words; embed only the peak(s)). **poetic / social / music-video / showcase / "make it cinematic" → recommend Cinematic.** When unsure, recommend **Standard** (pure-embed on explainer content is the common mistake) — but present both and let the user choose.

---

## Pipeline — 6 steps

**Project directory.** All artifacts live in `PROJECT_DIR = videos/<project-name>/` — the same convention as the other video workflows (`product-launch-video` / `faceless-explainer` / `pr-to-video`). The cwd stays the agent **workspace root** (it should hold only harness state like `.claude/skills/` + `node_modules/`), and every artifact — the project, matte frames, transcript, `index.html` / `rail.html`, `final.mp4` — is written under that one subdirectory. Derive `<project-name>` from the clip (kebab-cased source filename); if the user names a directory (e.g. `videos/acme-cut`), use it. **`<project>` in every step below = this `PROJECT_DIR`.** Don't init at the workspace root, and don't nest another project inside `PROJECT_DIR`.

```
1. hyperframes init <project> --non-interactive --video <video.mp4> --skip-skills   # <project> = videos/<project-name>
2. node scripts/matte.cjs <project>            # → frames_fg/*.png (RVM matte, onnxruntime-node)
3. node scripts/transcribe.cjs <project>       # → transcript.json (Whisper, our schema)
4. [AGENT STEP] mode-dependent — see below
5. (Cinematic mode only) node scripts/make-composition.cjs <project>
6. bash scripts/render-and-composite.sh <project>  # → final.mp4 + history/ snapshot
```

Step 4 differs by mode:

### Step 4 — Cinematic mode (pure embed)

1. Pick a template from the [modes/template/](modes/template/) catalog by scene fit (or the one the user named)
2. Read its `spec.md` for required layout decisions
3. Write `<project>/plan.json`: `template`, `duration`, `fps`, `width`, `height`, layout fields per the spec, and `groups[]` (each with `slot` + `tone` + `in/out` + `words`)
4. Step 5 compiles plan.json → index.html; the gates (`check-timing`, `check-occlusion`) run before render

### Step 4 — Standard mode (rail + embed)

**Read [modes/standard/PIPELINE.md](modes/standard/PIPELINE.md) FIRST** — it is the contract and overrides the library's `_anatomy.md` for this skill (RVM matte, our element contract, two files).

1. Read the transcript; pick the peak beat(s) (the headline word → **embed**) and the rest (→ **rail**, verbatim).
2. **Pick the 3 templates** that best fit the content + scene (match each file's `## Triggers`); read those 3 + the 2–3 motion recipes they name in [modes/standard/_motion.md](modes/standard/_motion.md). Build one (or blend tokens).
3. Author `<project>/index.html` — source video + the **embed climax** in `#stage` (skeleton + the template's style tokens + a `CLIMAX_IN`/`CLIMAX_OUT`).
4. Author `<project>/rail.html` — the **verbatim rail** only, transparent (words from `transcript.json`, active word `.act`, a `FLOW_IN`/`FLOW_OUT`).
5. Render: `bash scripts/render-and-composite.sh <project>` renders both, RVM-mattes the climax behind the subject, alpha-overlays the rail in front. No `plan.json` → template gates skip (`check-overflow.js` still warns); self-check rail timing + embed scarcity per PIPELINE.md.

---

## Catalog of shipped templates

| Template | Frame | Look | Spec |
|---|---|---|---|
| cinematic-cream | 16:9 + 9:16 (DNA-only) | DNA-only: Inter + soft/present motion + warm-cream palette. Agent composes planes + per-group typography + block-synced accumulation per scene. Unified template replacing memory-wall/champion/portrait-header for this aesthetic family. | [template.html](modes/template/cinematic-cream/template.html) header |
| memory-wall | 16:9 landscape | Italic poem + uppercase climax, right-aligned cascade (superseded by cinematic-cream, kept for reference) | [spec](modes/template/memory-wall/spec.md) |
| champion | 16:9 landscape | Side column + center-stage crown crossing subject (superseded by cinematic-cream) | [spec](modes/template/champion/spec.md) |
| portrait-header | 9:16 portrait | Centered header strip + optional bottom crown (superseded by cinematic-cream) | [spec](modes/template/portrait-header/spec.md) |

> **Note:** these are the **Cinematic** (pure-embed) templates — they composite text into the scene with no rail. For **rail + embed** (most explainer / voiceover), use **Standard mode** → the 54-template design library in [modes/standard/](modes/standard/).

To add a new template: see [modes/template/README.md § Adding a new template](modes/template/README.md).

---

## Aesthetic decision — tone × shot × platform

Before picking a template, classify the clip on 3 axes:

**Tone** (what feel does the content have?)
- documentary | conversational | energetic | poetic | keynote | investigative | music-video

**Shot** (what's the framing?)
- close-up (head + shoulders) | mid-shot (torso+) | wide (full body+) | cut-montage (mixed shots)

**Platform** (where will it play?)
- 9:16 portrait (TikTok/IG/Shorts) | 16:9 landscape (YouTube/web) | 1:1 square | broadcast export

Cross-reference in [references/direction-catalog.md § Classification matrix](references/direction-catalog.md) → direction → Cinematic template OR Standard design.

## Composition craft (embed track) — read before embedding

The full **embed-track** playbook lives in **[references/composition-craft.md](references/composition-craft.md)**:
transcript role-annotation, phrase grouping, planes & clean-zone anchoring, zone coherence,
climax pop & readability, edge-breathing, the occlusion 3-step judgement, and
accumulation/persistence. It governs how a *promoted* phrase sits INTO the scene — read it
before authoring any embed (Cinematic `plan.json` or Standard `index.html`). The default **rail**
track has its own, much simpler spec → **[references/rail.md](references/rail.md)**.

---

## Shared knowledge

| Doc | What |
|---|---|
| [references/rail.md](references/rail.md) | **The rail track** — standard lower-third subtitle spec (the default; carries most text). |
| [references/composition-craft.md](references/composition-craft.md) | **The embed-track playbook** — grouping, planes, climax pop, occlusion judgement, accumulation/persistence. Read before embedding. |
| [references/aesthetic-principles.md](references/aesthetic-principles.md) | **The 18 rules.** Beat Veed AI on taste. Read first. |
| [references/motion-vocabulary.md](references/motion-vocabulary.md) | 10 named motion primitives + tone→timing lookup |
| [references/direction-catalog.md](references/direction-catalog.md) | 10 ship-ready aesthetics + tone×shot×platform matrix |
| [references/anti-patterns.md](references/anti-patterns.md) | Bugs already locked out (CoreML, letter-spacing reflow, etc.) |
| [references/scene-types.md](references/scene-types.md) | When a wall surface is usable (4 conditions) |
| [references/layout-heuristics.md](references/layout-heuristics.md) | Plane positioning, clean-zone selection, crown 3 conditions, pillarbox math |
| [references/typography-presets.md](references/typography-presets.md) | Font-size × column-width matrix (starting points) |
| [references/caption-grouping.md](references/caption-grouping.md) | Word → group rules (pauses, sentence boundaries) |
| [references/failure-modes.md](references/failure-modes.md) | Long tail of dev gotchas |
| [references/bespoke-vs-presets.md](references/bespoke-vs-presets.md) | Why presets fail sometimes; clone-and-tweak pattern |

**Read the aesthetic principles and direction catalog FIRST.** Everything else is implementation detail.

---

## Non-negotiables

- **Face must never be 100%-covered continuously** — every 0.3s window, face bbox ≥30% uncovered.
- **WCAG contrast** — final render lints; fix palette if it fails.
- **Deterministic** — no `Math.random()`, no `Date.now()`, no `repeat:-1`.
- **Never grade/recolor the video.** The footage ships untouched — captions are the only addition. No full-frame scanlines / duotone / darken / vignette over the a-roll. Cyberpunk/CRT texture belongs *inside* a caption element, not over the whole frame.
- **Rail-first for talking-head / explainer.** Don't embed the whole transcript — most text is the rail; embed only peaks. Embedding everything is the default mistake.
- **Embed is scarce + spaced.** ≤1 embed per sentence/beat, never two adjacent or co-visible, ≥ a beat apart, at most one `apex`. climax = per-beat peak, **not** "the single payoff of the entire clip."
- **Matte = the subject (RVM person matting).** RVM segments people, not props — a gripped mic/cup is best-effort and may not be fully captured, and bright incidental objects can leak in. Sample `frames_fg/` and sanity-check before relying on tight prop occlusion.
- **Captions stay on-frame.** Cinematic mode hard-gates frame-overflow; Standard mode runs `check-overflow.js` as a WARNING (intentional bleed is the only exception — read the warning).
- **Each caption ≥ 0.5s on screen** — shorter = unreadable.
- **Word timings must match transcript.json within 80ms** — a caption firing 500ms off-beat destroys the scene illusion. `render-and-composite.sh` runs `check-timing.cjs --strict` before rendering; fix drift before the gate. Never pack multiple transcript words into one entry (e.g. `"FUTURE OF"` or `"IT<br> ALL"` with one start/end) — the second word inherits the first's timestamp and fires early. Split them into separate word entries with their own timings, even if you want them on the same visual line (use CSS `white-space` / natural wrap instead of `<br>`). Creative substitutions where caption text ≠ transcript (e.g. `"15%"` replacing `"fifteen percent"`) are supported — register them in `CREATIVE_SUBS` inside `check-timing.cjs`.
- **Group windows must envelop their words** — `group.in ≤ min(word.start)` and `group.out ≥ max(word.end)` for every group. If `group.in` is later than a word's start, the word is silently delayed until the container mounts (we've shipped 800ms lag bugs from this). The validator enforces this.
- **No two caption groups may overlap in both time AND screen region** — overlapping-in-time captions create text-on-text pileups. Options: (a) **spatial separation** — place each group in a non-overlapping vertical band so they can coexist (memory-wall cascade style); (b) **handoff** — set the earlier group's `out` ≤ the next group's `in` so only one is on screen; (c) **deliberate layered typography** — add `"allow_overlap": true` on one of the groups to silence the validator. The validator estimates each group's vertical bbox from its CSS and flags collisions. Pick (a) by default — it's what makes cinematic-cream feel like a poem accumulating, not a subtitle track replacing itself.
- **Screen-blend fails on bright backgrounds (>180 luminance).** **Cinematic** templates are cream + `screen` and that DNA is **locked** (the plan can't recolour them) → on a bright backdrop they wash out, so **switch to Standard mode** (opaque rail) rather than overriding a template. In **Standard**, set `mix-blend-mode: normal` + opaque colour directly in the HTML.
- **Don't animate `letter-spacing` or `filter:blur` on word entrance** — inline-block reflow causes line-jumps.
- **CoreML banned for RVM matting** — it corrupts face alpha, so matting is CPU-only (~3 fps @1080p ≈ 1 min per 10s clip; budget for it on long clips).

---

## Dependencies

- **hyperframes**, built (`packages/cli/dist/cli.js`). Scripts auto-resolve the checkout: `HYPERFRAMES_ROOT` env → repo root if this skill ships *inside* hyperframes → `~/Downloads/hyperframes`. Build with `bun install && bun run build`.
- **No Python — Node-only.** Everything runs on the toolchain hyperframes already ships: RVM matting via **`onnxruntime-node`**, image/alpha math via **`sharp`**, layout/occlusion/overflow via **`puppeteer`**, plus **`ffmpeg`**. The scripts auto-resolve these from the hyperframes checkout — nothing extra to install.
- **Transcription = hyperframes' Whisper** (whisper.cpp — native C++, no API key, no Python). `transcribe.cjs` wraps `hyperframes transcribe`; hyperframes auto-installs whisper.cpp (Homebrew or source build) and the model on first run. Falls back to an existing word-level `transcript.json` if present.
- **Source video** — `matte.cjs` / `transcribe.cjs` auto-resolve `source.mp4` (or glob the clip / read `hyperframes.json`), so `hyperframes init --video X.mp4` needs no manual rename.
- **fps** — `matte.cjs` extracts at the source's native rate and records `matte.fps`; `render-and-composite.sh` uses that so the matte stays frame-aligned.
- `assets/rvm_mobilenetv3_fp32.onnx` (14 MB) — auto-downloaded on first matte run.

If a hard dependency is missing, STOP and ask the user — don't silently skip steps.
