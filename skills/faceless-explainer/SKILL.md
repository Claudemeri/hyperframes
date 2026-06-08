---
name: faceless-explainer
description: faceless-explainer video workflow - arbitrary text (article / notes / topic / brief) -> narrator_scripts.json + audio (voice + BGM) + section_plan.md -> typography / abstract-graphics / diagram / data-viz video. Typical length up to ~3 min (sweet spot ~30-90s); a genuinely longer piece is general-video, not this workflow. Generates its OWN narration (TTS) — it does not sync to a user-supplied / pre-recorded voiceover (that is general-video). No website capture, no real product screenshots.
metadata:
  tags: orchestrator, pipeline, faceless-explainer, text-to-video
---

# faceless-explainer - dispatch entry

Input is **arbitrary text** (article / notes / topic / brief). Output is a **faceless explainer** video: no captured website, no product screenshots — every visual is invented by the LLM (typography / abstract graphics / diagram / data-viz), chosen per scene by content. The shipped style preset is always **pin-and-paper**.

All artifacts go to `PROJECT_DIR = videos/<project-name>/` (created in Step 0); all paths below are relative to it.

| Phase                    | Execution                                                                                                  | Primary artifact                                            | Detailed flow                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| init                     | Bash                                                                                                       | `hyperframes.json`                                          | Step 0                                    |
| scaffold                 | Bash (no agent)                                                                                            | `capture/extracted/tokens.json` + `visible-text.txt`        | Step 1                                    |
| design-system            | Bash (no agent, deterministic `pin-and-paper`)                                                             | `design-system/design.html` + `chunks/`                     | Step 1b                                   |
| scriptwriting            | subagent (`general-purpose`)                                                                               | `narrator_scripts.json`                                     | `agents/scriptwriting.md`                 |
| audio                    | `audio.mjs` in Bash                                                                                        | `audio_meta.json`                                           | `phases/audio/guide.md`                   |
| visual-design            | subagent (`general-purpose`)                                                                               | `section_plan.md`                                           | `agents/visual-design.md`                 |
| prep                     | `prep.mjs` in Bash                                                                                         | `group_spec.json`                                           | `scripts/prep.mjs`                        |
| captions (deterministic) | `captions.mjs group` -> `captions.mjs html` in Bash (no subagent)                                          | `caption_groups.json` + `compositions/captions.html`        | `scripts/captions.mjs`                    |
| scenes                   | N x subagent (`general-purpose`, parallel in the same message)                                             | `compositions/scene_*.html` or `compositions/group_w*.html` | `agents/hyperframes-scene.md`             |
| finalize (Phase 4c)      | Bash prelude (wait-bgm + assemble + inject/verify-transitions + sfx-verify + preflight) -> repair subagent | `renders/video.mp4`                                         | Step 7 / `agents/hyperframes-finalize.md` |

## Prerequisites

macOS Apple Silicon or Linux x64. System tools: `brew install python@3.11 node ffmpeg` (use Homebrew Python, **not** `/usr/bin/python3`, or `pip install` is blocked by PEP 668); then `npx hyperframes doctor` once (downloads Chrome). Optional cloud keys (else local fallbacks) — inject in Step 0.5:

| Key                                           | Used for                                    | Default / fallback                                             |
| --------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `HEYGEN_API_KEY`                              | TTS (cloud, word-level timestamps)          | voice: auto (first English starfish voice; override `--voice`) |
| `ELEVENLABS_API_KEY`                          | TTS (cloud; needs `pip install elevenlabs`) | voice `21m00Tcm4TlvDq8ikWAM` (Rachel)                          |
| neither set                                   | TTS                                         | local Kokoro, voice `am_michael` (non-English: pass `--voice`) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` (aliases) | Lyria BGM                                   | unset -> local MusicGen (first run downloads ~300 MB)          |

## Flow

### Step 0 - Initialize the video project

cwd is the agent workspace root (e.g. `/tmp/explainer-video-...`). Write all video artifacts under `PROJECT_DIR = videos/<project-name>/`.

`<project-name>`: use the directory the user gave (e.g. `Use ./videos/refactoring-explainer`), else a short kebab-case name derived from the input topic (`<topic>-explainer` / `<topic>-howto`). **Not** the workspace basename or a timestamp.

Only when `$PROJECT_DIR/hyperframes.json` is absent:

```bash
PROJECT_DIR="${LAUNCH_VIDEO_DIR:-videos/<project-name>}"
mkdir -p "$(dirname "$PROJECT_DIR")"
npx hyperframes init "$PROJECT_DIR" --non-interactive --skip-skills --example=blank
```

> `hyperframes init` drops a generic `AGENTS.md` / `CLAUDE.md` into `$PROJECT_DIR`; **leave them in place** — they are agent scaffolding for whoever opens the finished project later. This skill (not those files) is the source of truth for the workflow, so do not treat their generic guidance as run-time constraints.

**Constraints:** never run `hyperframes init` / generate `AGENTS.md` / `CLAUDE.md` in the workspace root; never nest another `hyperframes/` inside `PROJECT_DIR`; every Bash command (master + subagents) is a `(cd "$PROJECT_DIR" && ...)` subshell — never bare `cd`.

### Step 0.5 - API key guidance

Skip if `$PROJECT_DIR/.env` exists or `context.log` is non-empty (= not the first run). Otherwise tell the user: paste keys (→ Write `$PROJECT_DIR/.env`, one `KEY=value` per line, overwrite same-name) / "go" (already configured) / "skip" (local fallbacks). Then proceed to Step 1.

### Step 1 - Scaffold (Bash, NO agent, NO capture)

There is no website capture. Synthesize the minimal on-disk package the copied backend (`build-design --capture`, `prep --capture`) expects, directly from the user's text. `capture/` holds synthetic tokens + the input text (NOT a scrape); `capture/assets/` stays empty (faceless). With `colors:[]`, build-design uses the pin-and-paper native palette; if the user supplied brand colors, fill `colors[]` (`colors[0]` becomes the brand primary).

```bash
(cd "$PROJECT_DIR" && mkdir -p capture/extracted capture/assets)
(cd "$PROJECT_DIR" && cat > capture/extracted/tokens.json <<'JSON'
{ "title": "<title>", "description": "<one-line>", "colors": [], "fonts": [], "headings": [], "sections": [], "ctas": [], "svgs": [], "cssVariables": {} }
JSON
)
(cd "$PROJECT_DIR" && printf '%s\n' "<full input text / article / notes / brief>" > capture/extracted/visible-text.txt)
```

Validation:

```bash
[ -s "$PROJECT_DIR/capture/extracted/tokens.json" ] && \
[ -s "$PROJECT_DIR/capture/extracted/visible-text.txt" ] && \
[ -d "$PROJECT_DIR/capture/assets" ] && echo ok || echo missing
```

If any is missing, report and stop.

### Step 1b - Design system (Bash, NO agent, deterministic)

Three deterministic commands produce a fully-styled `design.html` + chunks against the synthetic input:

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/design-system/scripts/build-design.mjs ./design-system --no-emit --style pin-and-paper)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/design-system/scripts/build-design.mjs ./design-system --style pin-and-paper)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/design-system/scripts/emit-chunks.mjs ./design-system)
```

Validation:

```bash
[ -s "$PROJECT_DIR/design-system/inference.json" ] && \
[ -s "$PROJECT_DIR/design-system/design.html" ] && \
[ -s "$PROJECT_DIR/design-system/chunks/index.json" ] && echo ok || echo missing
```

If any is missing, read the build-design / emit-chunks stderr, fix the invocation, and rerun (deterministic, finishes in seconds).

### Step 2 - Scriptwriting

Dispatch one subagent. prompt = full contents of `agents/scriptwriting.md` + the `## Dispatch context` below, passed through verbatim:

```
SKILL_DIR: <absolute path>
PROJECT_DIR: <video project root>
Schema validator: <SKILL_DIR>/scripts/validate.mjs narrator
Input text: ./capture/extracted/visible-text.txt   # The source article / notes / brief — the agent reads this first
Design DNA: ./design-system/inference.json         # Read site_dna once to set the narrative register (soft register hint only)
Script style: Keep each scene's script concise — 1-2 sentences, no more than 20 words
```

The agent picks an explainer **structure** for `narrativeArchetype` (`concept-explainer` / `how-to-process` / `listicle` / `story-explainer`, or `"<outer> with <inner>"`) and emits `narrator_scripts.json` (it runs the validator before returning). `continuity` drives worker grouping: `continue` = same worker as the previous scene (a run of **up to 3** scenes, cap=3); `break` = new worker; scene 1 is always `break`. `intent` / `sharedMotif` are soft hints. `assetCandidates` is `[]` on essentially every scene (faceless).

### Step 3 - Audio

After `narrator_scripts.json` exists:

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/audio.mjs \
  --narrator-scripts ./narrator_scripts.json \
  --hyperframes . \
  --out ./audio_meta.json \
  --lyria-recipe <SKILL_DIR>/phases/audio/lyria-recipe.py)
```

BGM generation runs detached in the background when keys/deps allow, otherwise is silently skipped. Flags + BGM mechanics: top of `audio.mjs`.

- exit 0 -> voice + transcribe complete (BGM may still be rendering; `audio_meta.json` records `bgm_log` / `bgm_pid`), continue.
- exit 1 -> zero scenes produced voice; report and stop.

### Step 4 - Visual design

After `design-system/chunks/index.json`, `narrator_scripts.json`, and `audio_meta.json` exist, concatenate all inputs into one dispatch packet (contracts first, static references middle, work items last):

```bash
DP=/tmp/vd-dispatch.txt
{
  echo "## Design chunks"
  (cd "$PROJECT_DIR" && cat design-system/chunks/index.json \
    design-system/chunks/composition-hints.md design-system/chunks/voice.md \
    design-system/chunks/tokens.css design-system/chunks/easings.js 2>/dev/null)
  echo "## Effects catalog";  cat <SKILL_DIR>/phases/visual-design/effects-catalog.md
  echo "## Design rules";     cat <SKILL_DIR>/phases/visual-design/rules/{typography,color-system,composition,motion-language}.md
  echo "## SFX library";      cat <SKILL_DIR>/assets/sfx/manifest.json
  echo "## Narrator scripts"; (cd "$PROJECT_DIR" && cat narrator_scripts.json)
  echo "## Audio meta";       (cd "$PROJECT_DIR" && cat audio_meta.json 2>/dev/null)   # Optional; overrides Duration if drift >10%
} > "$DP"

# Captions planning hint (put it in the Captions: line of the dispatch below)
(cd "$PROJECT_DIR" && node -e 'try{const m=require("./audio_meta.json");process.stdout.write(Object.values(m.scenes||{}).some(s=>s.wordsPath)?"enabled":"disabled")}catch{process.stdout.write("enabled")}')
```

Then dispatch the visual-design subagent. prompt = full contents of `agents/visual-design.md` + the `## Dispatch context` below, verbatim:

```
SKILL_DIR: <absolute path>
PROJECT_DIR: <video project root>
Schema validator: <SKILL_DIR>/scripts/validate.mjs section
Captions: <enabled | disabled>   # Planning hint from the node -e above: enabled => leave bottom ~17% as caption territory in prose
Dispatch packet: /tmp/vd-dispatch.txt   # Step 0 reads it once for all inputs
Visuals: faceless — every scene is typography / abstract graphics / diagram / data-viz invented from the script. assetCandidates is [] for most or all scenes; plan visuals from text, not from captured assets.
```

Output is `section_plan.md`. `type-roles.md` and component HTML bodies are not in the packet (worker responsibilities). The `Captions:` line is an optimistic hint; the authoritative gate is `group_spec.captions_enabled` from Step 5.

### Step 5 - prep (deterministic script, NO subagent)

After `section_plan.md` exists:

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/prep.mjs \
  --section-plan ./section_plan.md \
  --narrator-scripts ./narrator_scripts.json \
  $( [ -f audio_meta.json ] && echo "--audio-meta ./audio_meta.json" ) \
  --rules-dir <SKILL_DIR>/../hyperframes-animation/rules \
  --capture ./capture \
  --design-system ./design-system \
  --hyperframes . \
  --sfx-lib <SKILL_DIR>/assets/sfx \
  --out ./group_spec.json)
```

Merges all upstream artifacts into `group_spec.json` (parse `section_plan` anchors, validate effect/component ids, group by `Continuity` with cap=3, build `visual_clips[]` where a multi-scene continue worker becomes one `group_wN.html`, compute Tier-B `transitions[]` between different visual clips, copy assets/fonts/SFX). `capture/assets/` is empty, so asset-copy is a no-op (faceless). Internal logic: header of `prep.mjs`.

- exit 0 -> read stdout (scenes / groups / total duration / per-group) and append to `context.log`.
- exit 1 -> stderr names the failing scene + anchor (usually a malformed anchor or unknown effect/transition id); return to Step 4 and re-dispatch visual-design.

### Step 5.5 + Step 6 - Captions (deterministic) + scene worker fan-out

**Captions: two deterministic scripts (no subagent), after prep exits 0 and before fan-out:**

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs group \
  --group-spec ./group_spec.json --hyperframes . \
  --tokens design-system/chunks/tokens.css --out ./caption_groups.json)

(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs html \
  --hyperframes . --groups ./caption_groups.json \
  --tokens design-system/chunks/tokens.css \
  --inference design-system/inference.json \
  --out compositions/captions.html)
```

exit 0 = normal. If either prints `captions: skipped (<reason>)`, skip the whole chain: no `captions.html`, assemble won't mount track 12. Skin selection / self-check: top of `captions.mjs html`; for offline, pass `--skin-file`. **Do not** run `npx hyperframes lint` on `captions.html`.

Then read `group_spec.json.groups[]` for worker count N. Build the shared header once, then per-worker packets (`tokens` / `easings` / `voice` are identical for every worker):

```bash
mkdir -p /tmp/scene-dispatch
(cd "$PROJECT_DIR" && cat design-system/chunks/tokens.css design-system/chunks/easings.js design-system/chunks/voice.md 2>/dev/null) \
  > /tmp/scene-shared.txt
# Then per worker: shared header + that worker's Scenes YAML -> /tmp/scene-dispatch/w<N>.txt
```

Start **N scene workers in parallel in the same message** (`general-purpose`, each `run_in_background: true`). prompt = full contents of `agents/hyperframes-scene.md` + `## Dispatch context`, verbatim. Top-level fields: `SKILL_DIR` / `PROJECT_DIR` / `Worker ID` / `Captions: <enabled|disabled>` (= `group_spec.captions_enabled`) / `Dispatch packet: /tmp/scene-dispatch/w<N>.txt`, plus the shared header body + a `Scenes:` list.

For the worker top-level context, copy from `group_spec.json.groups[i]`: `worker_id`, `composition_id`, `composition_file`, `duration_s`, `scene_ids`. Copy every field in the **`Scenes:` list verbatim from `group_spec.json.groups[i].scenes[<sid>]`** (only that worker's 1-3 logical scenes): `scene_id` / `local_start_s` / `effects` / `rule_paths` / `assetCandidates` / `estimatedDuration_s` / `voicePath` / `design_chunks` (absolute paths to the whole component library — the worker chooses by visual judgment) / `creative_brief`. A 2-3 scene worker writes one `group_wN.html` with true shared DOM across the segments.

`assetCandidates` is `[]` for most or all scenes — the worker invents the visual from `creative_brief` + design chunks; there are no captured assets to place. `design_chunks: null` (chunks missing) → worker falls back to reading `./design-system/design.html` fully; should not happen in the normal path.

After all workers + captions return, run preflight (scans `group_spec.visual_clips[]`; does NOT check `captions.html`):

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/check-compositions.mjs \
  --hyperframes . \
  --group-spec ./group_spec.json)
```

- exit 0 -> all compositions pass, continue to Step 7.
- exit 1 -> stderr names the violating scene + rule category; return to Step 6 and re-dispatch the affected worker (do not Edit in the master — fix upstream).

### Step 7 - Assembly prelude + preflight gate + finalize

After Step 6 exits 0: a deterministic Bash prelude, then one repair finalize subagent (snapshot QA -> one in-place fix pass -> render). `compositions/scene_N.html` / `group_wN.html` are worker source files; editing them edits the source.

**(1) BGM wait + assembly (Bash):**

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/wait-bgm.mjs \
  --audio-meta ./audio_meta.json \
  --hyperframes . \
  --timeout-ms 120000 \
  --interval-ms 2000)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/assemble-index.mjs --group-spec ./group_spec.json --hyperframes .)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/transitions.mjs inject --group-spec ./group_spec.json --hyperframes .)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/transitions.mjs verify --group-spec ./group_spec.json --index ./index.html)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/verify-output.mjs sfx --group-spec ./group_spec.json --index ./index.html)
```

`inject` only changes the `index.html` shell `data-start`/`data-duration`/`data-track-index`, never visual roots. Internal logic: header of each script.

- assemble exit 1 -> names a visual composition (root `data-duration` != group_spec, or file missing) = worker contract break → return to Step 6, re-dispatch that worker, rerun this step.
- inject/verify-transitions exit 1 -> injector bug (prep already validated `transitions[]`) → report, don't roll back workers.
- sfx-verify exit 1 -> assembler bug → report.

**(2) Preflight gate (Bash):**

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/preflight-finalize.mjs --group-spec ./group_spec.json --hyperframes .)
```

preflight writes everything the agent should not judge into `finalize_brief.json`: warms a pinned `npx hyperframes@<version>` cache, runs lint/validate/inspect (captures tails), computes the snapshot timeline, runs `captions.mjs keepout` (when `captions_enabled`) with ready-to-apply `edit_old`/`edit_new` strings, and runs `check-rendered-perception.mjs` (Puppeteer geometry incl. cross-text-collision). Fields + algorithm: top of `preflight-finalize.mjs`.

- exit 0 -> all gates pass -> dispatch finalize.
- exit 2 -> **BLOCKING**: lint/validate/inspect has a real ERROR. Do NOT dispatch finalize, do NOT bypass with `--allow-gate-failure`. Read `finalize_brief.json.gates.<gate>.output_tail`: `text_box_overflow` / `*_overflow` usually = re-dispatch that worker (Step 6, include the inspect selector + scene); rare by-design overflow → add `data-layout-allow-overflow="true"` and rerun. `lint` / `validate` schema/selector/asset issue → `Edit` the file, rerun preflight.
- exit 1 -> preflight crashed (bad invocation / missing group_spec) → fix the invocation.

Scan `anomalies[]` even on exit 0 (loud non-blocking warnings; common: `perception_check_skipped` when Puppeteer is absent → finalize snapshots become the only safety net; each anomaly carries `actionable_install_command`).

**(3) Dispatch finalize subagent** (`general-purpose`). prompt = full contents of `agents/hyperframes-finalize.md` + `## Dispatch context`:

```
SKILL_DIR: <absolute path>
PROJECT_DIR: <video project root>
Render quality: high     # Or draft / standard
Finalize brief: <PROJECT_DIR>/finalize_brief.json   # Agent reads once for gate results + npx_prefix + snapshot_times_s
Visual clips:            # One line per group_spec.visual_clips[] entry
  - { id, file, kind, worker_id, scene_ids, start_s, duration_s }
Scenes:                  # One line per logical scene, copied verbatim from group_spec.json
  - { scene_id, start_s, estimatedDuration_s, effects: [...], creative_brief: |
      <Phase 3 prose for this scene> }
```

Normal path (`preflight_clean: true`): finalize skips straight to snapshots (pass the brief's `snapshot_times_s` to `--at` at once) -> visual QA -> one in-place repair pass -> render (brief's `npx_prefix`) -> verify-render. Exception path: branch by failure site in the brief (gate failure → inspect `output_tail`, Edit, rerun that gate; caption keep-out → apply each `caption_keepout.violations[].edit_old/edit_new`, then run `captions.mjs keepout` once). **Finalize must never change a visual root `data-duration`** (= `visual_clips[].duration_s`, fixed upstream; changing it makes assemble fatal — timing is only fixable by returning to Step 6).

- finalize reports the mp4 (verify-render passed) + gate/snapshot status + files repaired in place -> complete.
- finalize STOP (only when a scene needs full recomposition) -> return to Step 6, re-dispatch that worker, rerun (1)+(2), re-dispatch finalize.

### Completion report

Summarize per phase: input title / topic, preset (always `pin-and-paper`), explainer structure, scene count / total duration, worker grouping, transitions, gate status, visual files repaired in place, final mp4 path + bytes + duration.

---

## Resume table

Read `$PROJECT_DIR/context.log` and resume from:

| State                                                                                            | Continue from                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| log missing or empty                                                                             | Full pipeline                                                                                                                                                                                           |
| `capture/extracted/tokens.json` **or** `visible-text.txt` missing                                | Step 1 (scaffold)                                                                                                                                                                                       |
| scaffold done, `design-system/inference.json` **or** `chunks/index.json` missing                 | Step 1b (three deterministic commands)                                                                                                                                                                  |
| `chunks/index.json` exists, `narrator_scripts.json` missing                                      | Step 2 (scriptwriting). If the user supplied a final `narrator_scripts.json`, place it in `$PROJECT_DIR/` to skip this state                                                                            |
| `narrator_scripts.json` exists, `audio_meta.json` missing                                        | Step 3 (audio)                                                                                                                                                                                          |
| `audio_meta.json` exists, `section_plan.md` missing                                              | Step 4 (visual-design)                                                                                                                                                                                  |
| `section_plan.md` exists, `group_spec.json` missing                                              | Step 5 (prep)                                                                                                                                                                                           |
| `group_spec.json` exists, any `visual_clips[].file` missing **or** `caption_groups.json` missing | Step 5.5+6 (run `captions.mjs group` -> `html`, then dispatch workers for missing clips). Captions-ran criterion = `caption_groups.json` exists (NOT `captions.html`, since a legal skip produces none) |
| all `visual_clips[].file` exist + captions decided, `renders/video.mp4` missing                  | Step 7 (rerun assemble + sfx-verify + preflight, overwriting `finalize_brief.json` / `index.html`, then dispatch finalize)                                                                              |
| `renders/video.mp4` exists                                                                       | Report completed and stop                                                                                                                                                                               |

## Directory shape

```text
./                            # workspace root
├── .claude/skills/
├── node_modules/  package.json
└── videos/<project-name>/    # PROJECT_DIR - HyperFrames project root
    ├── hyperframes.json  context.log
    ├── capture/              # synthetic package (NOT a scrape) — kept for backend layout compatibility
    │   ├── extracted/        # tokens.json (synthetic) + visible-text.txt (the input text)
    │   └── assets/           # empty (faceless)
    ├── design-system/        # build-design outputs: inference.json / design.html / chunks/ / fonts/
    ├── narrator_scripts.json  audio_meta.json  section_plan.md  group_spec.json
    ├── public/  assets/  compositions/  snapshots/
    └── renders/video.mp4
```
