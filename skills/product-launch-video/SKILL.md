---
name: product-launch-video
description: product-launch video workflow - a product / marketing URL (crawled with headless Chrome for brand tokens + assets) OR a pre-written script / text brief (if it names a product site, the agent offers to crawl it for brand tokens + assets; otherwise no-capture mode with a style preset supplying the palette + design system; the script can be used verbatim as the voice-over or restructured) -> narrator_scripts.json + audio (voice + BGM) + section_plan.md -> a product launch / SaaS / promo video (up to ~3 min; sweet spot ~30-90s) rendered to MP4. Use for marketing, launching, or promoting a specific product / company / app / website. Triggers - "launch video for X", "promo for our site", "explain my SaaS in a minute", "feature reveal for X.com", "I have a script, turn it into a 60s promo". NOT for - a topic / concept explainer with no product and no URL (-> faceless-explainer); a GitHub PR / code change (-> pr-to-video); a general (non-launch) website to turn into a video (-> website-to-hyperframes); adding captions to an existing video (-> embedded-captions).
metadata:
  tags: orchestrator, pipeline, product-launch
---

# product-launch-video - dispatch entry

All artifacts are written to `PROJECT_DIR = videos/<project-name>/` (created in Step 0). All paths in the table below are relative to `PROJECT_DIR`.

| Phase                    | Execution                                                                                                                                  | Primary artifact                                     | Detailed flow                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| init                     | Run Bash directly                                                                                                                          | `hyperframes.json`                                   | Step 0 (this file)                                         |
| capture                  | Run `hyperframes capture` directly in Bash                                                                                                 | `capture/extracted/tokens.json`                      | `phases/capture/guide.md`                                  |
| design-system            | subagent (`general-purpose`)                                                                                                               | `design-system/design.html` + `chunks/`              | `agents/design-system.md`                                  |
| story-design             | subagent (`general-purpose`)                                                                                                               | `narrator_scripts.json`                              | `agents/story-design.md`                                   |
| audio                    | Run `audio.mjs` directly in Bash                                                                                                           | `audio_meta.json`                                    | `phases/audio/guide.md` (the script is the flow)           |
| visual-design            | subagent (`general-purpose`)                                                                                                               | `section_plan.md`                                    | `agents/visual-design.md`                                  |
| prep                     | Run `prep.mjs` directly in Bash                                                                                                            | `group_spec.json`                                    | `scripts/prep.mjs` (the script is the flow)                |
| captions (deterministic) | Run `captions.mjs group` -> `captions.mjs html` directly in Bash (no subagent)                                                             | `caption_groups.json` + `compositions/captions.html` | `scripts/captions.mjs group` / `scripts/captions.mjs html` |
| scenes                   | N x subagent (`general-purpose`, parallel in the same message)                                                                             | `compositions/scene_*.html`                          | `agents/hyperframes-scene.md`                              |
| finalize (Phase 4c)      | Bash prelude (wait-bgm + assemble-index + sfx-verify + preflight) -> repair subagent (snapshot visual QA + one in-place fix pass + render) | `renders/video.mp4`                                  | SKILL.md Step 7 / `agents/hyperframes-finalize.md`         |

## Prerequisites (install before first run)

macOS Apple Silicon or Linux x64. System tools:

```bash
brew install python@3.11 node ffmpeg                   # On Linux, use the apt/dnf equivalent
npx hyperframes doctor                                  # One-time check that Chrome / dependencies are ready
```

- `python@3.11` (**use Homebrew Python, not system `/usr/bin/python3`**, or `pip install` will be blocked by PEP 668; used by the MusicGen fallback in the audio phase)
- `node >= 18` - used by `npx hyperframes`
- `ffmpeg` - `audio.mjs` uses `ffprobe` to read voice duration
- `hyperframes` CLI - Phase 1 capture and design-system share the same capture; on first `npx hyperframes capture`, the browser manager downloads Chrome automatically

Optional API keys (if unset, the workflow uses local fallbacks). Injection is described in Step 0.5. `GEMINI_API_KEY` and `GOOGLE_API_KEY` are equivalent aliases.

| Key                                      | Used for                                       | Default voice / fallback                                                                      |
| ---------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `HEYGEN_API_KEY`                         | TTS (cloud, with word-level timestamps)        | voice: auto (first English starfish voice; override `--voice`)                                |
| `ELEVENLABS_API_KEY`                     | TTS (cloud; requires `pip install elevenlabs`) | voice `21m00Tcm4TlvDq8ikWAM` (Rachel)                                                         |
| Neither set                              | TTS                                            | local Kokoro, voice `am_michael` (for non-English, pass `--voice`)                            |
| `GEMINI_API_KEY` (one key for both uses) | Capture vision caption + Lyria BGM             | unset -> captions use DOM context only; BGM uses local MusicGen (first run downloads ~300 MB) |

## Flow

### Step 0 - Initialize the video project

cwd is the agent workspace root (for example `/tmp/launch-video-202347`) and should only contain harness state such as `.claude/skills/` and `node_modules/`. All video artifacts are written to the subdirectory `PROJECT_DIR = videos/<project-name>/`.

**Naming `<project-name>`**:

- If the user prompt explicitly gives a directory (for example `Use ./videos/acme-launch`), use it directly.
- Otherwise the orchestrator chooses a short, clear kebab-case name, such as `<brand>-promo` / `<product>-launch`. **Do not** use the workspace basename or timestamp (`launch-video-204613` is wrong).
- If only a URL is available, derive the name from the domain/page title first; it may be renamed before `capture/` is written, and becomes fixed after that.

**Initialization** (only when `$PROJECT_DIR/hyperframes.json` does not exist):

```bash
PROJECT_DIR="${LAUNCH_VIDEO_DIR:-videos/<project-name>}"
mkdir -p "$(dirname "$PROJECT_DIR")"
npx hyperframes init "$PROJECT_DIR" --non-interactive --skip-skills --example=blank
rm -f "$PROJECT_DIR/AGENTS.md" "$PROJECT_DIR/CLAUDE.md"   # Workflow constraints live in this skill; do not rely on project-local helper docs
```

> `AGENTS.md` / `CLAUDE.md` are generated only once during `hyperframes init` - deleting them once above is enough. **Later capture / build-design / any phase will not regenerate them**, so do not repeat `rm` in later Bash blocks.

**Constraints** (violating any one of these makes later phases unable to find artifacts or triggers lint errors):

- Do not run `hyperframes init` or generate `AGENTS.md` / `CLAUDE.md` in the workspace root.
- Do not create another `hyperframes/` subproject inside `PROJECT_DIR`.
- Every subagent dispatch context contains a line `PROJECT_DIR: <path>`; the subagent treats it as the project root, and Bash commands use `(cd "$PROJECT_DIR" && ...)` subshells.
- **cwd discipline (the master follows this too)**: every Bash command in this skill must be copied as a `(cd "$PROJECT_DIR" && ...)` subshell. **Do not improvise it into bare `cd "$PROJECT_DIR" && ...`**. Bare `cd` changes the shell's persistent cwd, so the next command's relative paths drift and you must `pwd`/`cd` back, which is wasted work. Subshell form gives every command its own cwd, keeps commands independent, and makes them safe to copy out of order.

The complete directory shape is in "Design notes / Directory shape" at the end. Artifact paths for each phase are already shown in that step's commands.

### Step 0.5 - API key guidance

**Skip condition**: `$PROJECT_DIR/.env` already exists, or `context.log` is non-empty (= not the first run). Otherwise tell the user:

> This workflow can optionally use cloud keys (see the prerequisite table above). It also runs without them by using local fallbacks. Reply with:
>
> - paste keys -> I will write them to `$PROJECT_DIR/.env`
> - "go" -> I will assume they are already configured (shell `export` or `.env`)
> - "skip" -> use local fallbacks for everything

**Response handling**:

- Pasted keys -> Write/Edit `$PROJECT_DIR/.env`, one `KEY=value` per line; overwrite same-name keys. Do not judge or change paths.
- "go" / "skip" / "already set" -> proceed directly to Step 1.

### Step 1 - Capture (Phase 1)

1. Resolve `SKILL_DIR` and any explicit `TARGET_URL` from the prompt.
2. Resolve Step 0 and ensure `PROJECT_DIR` exists.
3. Read `$PROJECT_DIR/context.log` if it exists, and use the Resume table below to skip completed phases.
4. **Classify the input first** (Step 1.0 below) to fix two flags — `CAPTURE` (crawl a site or not) and `VO_MODE` (how story-design treats a user-supplied script) — then **run Bash directly**. Whichever path you take, **both share the `derive-context-pack` + `build-design --no-emit` steps** (design-system consumes capture artifacts directly):

#### Step 1.0 - Classify the input (set CAPTURE + VO_MODE)

| Input shape                                          | What to do                                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Explicit URL in the prompt**                       | `TARGET_URL` = that URL; `CAPTURE=yes`; no user script → narration is generated from the captured site (skip the voice-over question). Take the capture path (A).                                         |
| **User pasted / pointed at a script or brief**       | (1) Save the verbatim text to `$PROJECT_DIR/user_script.txt`. (2) **Ask the voice-over question once** (below) → set `VO_MODE`. (3) **Resolve a capture target from the script** (below) → set `CAPTURE`. |
| **A topic / brief with no script prose, no product** | `CAPTURE=no`; no voice-over question (there is no user wording to preserve — story-design writes from the brief). Take the no-capture path (B).                                                           |

**Voice-over question** (only when the user supplied actual script prose) — ask one short line and wait:

> Should I use your script **verbatim** as the voice-over, or **restructure** it into more screen-ready scene narration?
>
> - Verbatim — keep the original wording; I only split scenes and pair visuals. Duration follows the script.
> - Restructure — treat it as a brief and rewrite tighter narration, 1-2 sentences per scene.

Set `VO_MODE = verbatim | restructure` (default `restructure` if the user is indifferent). It is threaded to story-design in Step 2.

**Resolve a capture target from the script** — by default look for a site and crawl it (real brand colors / fonts / assets beat a preset fallback). **Skip to `CAPTURE=no` only when the user opted out** ("do not search / no web / text-only / no capture / don't search"). Otherwise, in order:

1. **An explicit `http(s)://…` URL in the script** → `TARGET_URL` = it; `CAPTURE=yes`. Announce it; no need to ask.
2. **A clear brand / product name but no URL** → run `WebSearch` to resolve the official site, then **confirm the single resolved URL with the user in one line** before crawling (search can land on the wrong domain). On confirm → `TARGET_URL` + `CAPTURE=yes`; if the user declines or nothing credible turns up → `CAPTURE=no`.
3. **No site derivable** → `CAPTURE=no`.

> **Capture + user script coexist.** When `CAPTURE=yes` **and** `user_script.txt` exists, the crawl supplies **only** brand tokens + assets + visual register — the **narration spine stays `user_script.txt`** (Step 2 honors it via `VO_MODE`, never the site's own copy). When `CAPTURE=no`, take path (B) (synthesize the minimal capture package) and `user_script.txt` is the brief.

**(A) Capture path (`CAPTURE=yes`)** - hyperframes capture:

```bash
(cd "$PROJECT_DIR" && npx hyperframes capture "<TARGET_URL>" -o ./capture)
```

**(B) No-capture path (`CAPTURE=no` — pure text video, or a user script with no derivable site)** - do not capture; synthesize a minimal capture package and feed it into the same downstream path. **The preset is chosen by you (master)** because no site can be inferred; choose from the 19 presets according to the user's intent, or ask one short question. The full user script/brief goes into `visible-text.txt`; `colors:[]` makes build-design use the **R2 preset-palette fallback** (a complete readable palette exists even without brand colors; if the user specified brand colors, fill `colors`, which overrides the preset defaults):

```bash
(cd "$PROJECT_DIR" && mkdir -p capture/extracted capture/assets)
(cd "$PROJECT_DIR" && cat > capture/extracted/tokens.json <<'JSON'
{ "title": "<brand/title>", "description": "<one-line>", "colors": [], "fonts": [], "headings": [], "sections": [], "ctas": [], "svgs": [], "cssVariables": {} }
JSON
)
(cd "$PROJECT_DIR" && echo '{}' > capture/extracted/design-styles.json)
(cd "$PROJECT_DIR" && printf '%s\n' "<full user script / brief>" > capture/extracted/visible-text.txt)
```

> Path B satisfies both "user-provided script" and "no asset capture" at once: `narrator_scripts` is still generated by Step 2 story-design from `user_script.txt` (honoring `VO_MODE`; all scenes use `assetCandidates: []`, so the video is text/typography only). If the user **already has a final `narrator_scripts.json`**, place it in `$PROJECT_DIR/`; the Resume table will skip story-design.

**Shared downstream for both paths** (Path B build-design **must include `--style <chosen-preset>`** to force the preset; Path A omits it and uses auto-inference):

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/derive-context-pack.mjs --capture ./capture)
# Deterministically outputs design-system/inference.json (site_dna + preset scoring / forced preset). Step 1b and Step 2 both read it and fork in parallel.
(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/design-system/scripts/build-design.mjs ./design-system --no-emit)   # Path B: append --style <chosen-preset>
```

Capture artifacts: `capture/extracted/{tokens,design-styles,animations,fonts-manifest,asset-descriptions,video-manifest,visible-text}.{json,md,txt}` + `capture/assets/` + `capture/screenshots/` + `capture/context_pack.md` (the LLM brief synthesized by derive-context-pack, read directly by Phase 2 / Phase 3) + `design-system/inference.json` (the deterministic output of `build-design.mjs --no-emit`: `site_dna` + preset candidate scoring; it does not output `design.html` / chunks - those belong to Step 1b).

Validation:

```bash
[ -s "$PROJECT_DIR/capture/extracted/tokens.json" ] && \
[ -s "$PROJECT_DIR/capture/extracted/design-styles.json" ] && \
[ -s "$PROJECT_DIR/capture/context_pack.md" ] && \
[ -s "$PROJECT_DIR/design-system/inference.json" ] && \
[ -d "$PROJECT_DIR/capture/assets" ] && echo ok || echo missing
```

If any are missing, report the error and stop. If `capture/BLOCKED.md` exists, the site hit anti-scraping / timeout; follow the instructions inside it.

### Step 1b + Step 2 - Visual system in parallel with story design (Phase 1b and Phase 2 parallel fork)

The Step 1 Bash phase has already deterministically produced `design-system/inference.json` and `capture/context_pack.md`. These two subagents **depend only on capture-phase artifacts and do not read each other's output**, so after capture exits 0, start them **in parallel in the same message** (each with `run_in_background: true`) - do not serialize them:

- **design-system** (Phase 1b): dispatch a subagent. `## Dispatch context` contains `SKILL_DIR` / `PROJECT_DIR` / `Target URL`, and includes the full Step 1 `inference.json` by `cat` (`(cd "$PROJECT_DIR" && cat design-system/inference.json)`, ~2-4 KB, saving the subagent one Read). The four-step flow of preset selection / brand color trimming / build-design / emit-chunks belongs to `agents/design-system.md`; the master does not need to expand it.

- **story-design** (Phase 2): dispatch a subagent. `## Dispatch context`:
  ```
  SKILL_DIR: <absolute path>
  PROJECT_DIR: <video project root>
  Schema validator: <SKILL_DIR>/scripts/validate.mjs narrator
  Design DNA: ./design-system/inference.json   # Read site_dna once at the start to set the narrative register (deterministic Step 1 artifact, independent of the design-system subagent)
  Provided script: ./user_script.txt   # ONLY when the user supplied a script (Step 1.0). This file is the narration spine; omit the whole line when there is no user script.
  Voice-over mode: <verbatim | restructure>   # From Step 1.0; pair it with the Provided script line. Omit when there is no user script.
  Script style: Keep each scene's script concise - 1-2 sentences, no more than 20 words   # Applies in restructure / no-user-script mode ONLY. In verbatim mode this budget is suspended — preserve the user's wording and let total length follow the script (see story-design guide "Provided-Script Modes").
  ```

### Step 3 - Audio (Phase 2.5)

After story-design returns and `narrator_scripts.json` exists, start audio (**it depends only on story-design**; design-system may still be running in parallel, and audio does not wait for it):

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/audio.mjs \
  --narrator-scripts ./narrator_scripts.json \
  --hyperframes . \
  --out ./audio_meta.json \
  --lyria-recipe <SKILL_DIR>/phases/audio/lyria-recipe.py)
```

**BGM preconditions** (if either is satisfied, detached BGM generation runs in the background; otherwise it is silently skipped and voice proceeds normally): `$GOOGLE_API_KEY` + existing `--lyria-recipe` -> Lyria cloud; otherwise installed `transformers torch soundfile numpy` -> local MusicGen (first run downloads ~300 MB; the script may pip-install in the background while TTS runs). BGM synthesis mechanics (seed clip / loop) and all optional flags (`--voice` / `--provider` / `--no-bgm` / `--bgm-prompt` / ...) are documented at the top of `audio.mjs`.

- exit 0 -> voice + transcribe complete (BGM may still be running in the background; `audio_meta.json` records `bgm_log` / `bgm_pid`), continue.
- exit 1 -> zero scenes produced voice; report the error and stop.

### Step 4 - Visual design (Phase 3)

**Join point**: after design-system and story-design have both returned (`design-system/chunks/index.json` + `narrator_scripts.json` exist) and audio has completed (`audio_meta.json` exists), concatenate **all inputs** for visual-design into one dispatch packet `/tmp/vd-dispatch.txt`. The subagent Step 0 reads it **once** and gets everything (catalog / rules / chunks / story), with zero additional Reads before writing the plan:

```bash
DP=/tmp/vd-dispatch.txt
{
  # Intentional section order: contract first, static references in the middle, work items last (see explanation below)
  echo "## Design chunks"
  # Project-level contracts (all on disk now; only non-empty chunks exist, and cat skips missing files automatically, avoiding two hops through index.json to check *_file)
  (cd "$PROJECT_DIR" && cat design-system/chunks/index.json \
    design-system/chunks/composition-hints.md design-system/chunks/voice.md \
    design-system/chunks/tokens.css design-system/chunks/easings.js 2>/dev/null)
  echo "## Effects catalog";  cat <SKILL_DIR>/phases/visual-design/effects-catalog.md
  echo "## Blueprints index"; cat <SKILL_DIR>/phases/visual-design/blueprints-index.md
  echo "## Design rules";     cat <SKILL_DIR>/phases/visual-design/rules/{typography,color-system,composition,motion-language}.md
  echo "## SFX library";      cat <SKILL_DIR>/assets/sfx/manifest.json
  echo "## Narrator scripts"; (cd "$PROJECT_DIR" && cat narrator_scripts.json)
  echo "## Audio meta";       (cd "$PROJECT_DIR" && cat audio_meta.json 2>/dev/null)   # Optional; used to override Duration if drift is >10%
} > "$DP"

# Captions planning hint (computed separately, not included in the packet; put it directly in the Captions: line of the dispatch below)
(cd "$PROJECT_DIR" && node -e 'try{const m=require("./audio_meta.json");process.stdout.write(Object.values(m.scenes||{}).some(s=>s.wordsPath)?"enabled":"disabled")}catch{process.stdout.write("enabled")}')
```

Then start the visual-design subagent. **Its prompt = the full contents of `agents/visual-design.md` + the `## Dispatch context` below, passed through verbatim**. You (master) do not need to pre-read or digest the agent prompt; copy it as-is (the flow details are read from the guide by the subagent itself):

```
SKILL_DIR: <absolute path>
PROJECT_DIR: <video project root>
Schema validator: <SKILL_DIR>/scripts/validate.mjs section
Captions: <enabled | disabled>   # Planning hint computed by the node -e above: enabled => leave key content in the upper ~83% and the bottom ~17% as caption territory in prose (see guide Section 4, rule 2)
Dispatch packet: /tmp/vd-dispatch.txt   # Step 0 reads it once to get all inputs; section order described below. Reading it is enough; normally no further disk Reads are needed
```

The here-doc section order is intentional: contracts (`## Design chunks`) are first so they get attention (violating composition-hints means render failure, and voice must be honored in prose), static references (catalog/blueprints/rules/SFX) are in the middle, and work items (`## Narrator scripts` + `## Audio meta`) are last. `type-roles.md` and component HTML bodies **are not included in the packet and are not read** (they are worker responsibilities). The `Captions:` line is only an optimistic planning hint; the authoritative gate is produced by Step 5 prep (see "Design notes / Captions gate").

### Step 5 - Phase 4a prep (deterministic script, NO subagent)

After Phase 3 visual-design exits and `section_plan.md` exists, run `prep.mjs` to merge all upstream artifacts into `group_spec.json`, consumed by Phase 4b/4c:

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

This merges all upstream artifacts (parse `section_plan` anchors, validate effect/component ids, group by `Continuity` with cap=2, compute `transitions[]`, copy assets/fonts/SFX) into `group_spec.json`. Internal logic is described in the header comments of `prep.mjs`; you (master) only need to inspect the exit code:

Exit codes:

- 0 -> read stdout (scenes / groups / total duration / per-group breakdown) and append it to `$PROJECT_DIR/context.log`.
- 1 -> stderr names the failing scene + anchor; go back to Step 4 and re-dispatch visual-design. **Most common fatal**: a pair of adjacent scenes requested a Tier-A (shared-element bridge) transition, but the cap=2 grouping split them across two workers, so the worker cannot touch both DOMs. Pass one of these fixes through to visual-design: (a) change that boundary to Tier-B (for example blur-crossfade); (b) set both scenes to `Continuity: continue` so they share a worker; (c) raise `--scenes-per-group`.

### Step 5.5 + Step 6 - Captions (deterministic) + scene worker parallel fan-out (Phase 4a.5 + 4b)

**Captions use no subagent at all - two deterministic scripts run in sequence** (after prep exits 0 and before scene fan-out, run directly in Bash; typically tens of milliseconds):

```bash
# (1) Word engine: whisper word stream -> caption_groups.json (clean/group/classify/global timing/scene+surface)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs group \
  --group-spec ./group_spec.json --hyperframes . \
  --tokens design-system/chunks/tokens.css --out ./caption_groups.json)

# (2) HTML engine: caption_groups.json + registry skin -> compositions/captions.html (replaces the old captions agent)
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs html \
  --hyperframes . --groups ./caption_groups.json \
  --tokens design-system/chunks/tokens.css \
  --inference design-system/inference.json \
  --out compositions/captions.html)
```

Both scripts are normal when they exit 0. If either prints `captions: skipped (<reason>)` (missing group_spec / whisper words / tokens.css / caption groups), skip the entire caption chain: no `captions.html` is generated, and assemble will not mount track 12. Skin selection, word annotation, tokenization, and node self-check (failure -> exit 1 without writing output) are all documented at the top of `captions.mjs html`; for offline usage, pass `--skin-file`. **Do not** run `npx hyperframes lint <file>` on `captions.html` (the lint argument is a project directory; passing a file exits 1). Whole-project lint is covered in Step 7.

Then read `group_spec.json.groups[]` to get worker count N. Start **N scene worker subagents in parallel in the same message** (captions have already been produced by the scripts above and are **no longer a subagent**). Before fan-out, read `group_spec.json.captions_enabled` (the single gate computed by `prep.mjs`): when `true`, every scene worker dispatch includes `Captions: enabled` (enables a bottom ~17% keep-out); when `false`, dispatch includes `Captions: disabled` (full frame).

**Two-part dispatch packet** (same idea as Step 4, but per scene worker): `tokens` / `easings` / `voice` are **project-level globals and identical for every worker**. First `cat` them into a shared header `/tmp/scene-shared.txt` once; then for **each** worker, build `/tmp/scene-dispatch/w<N>.txt` = shared header + that worker's per-scene YAML. Worker Step 0 reads its own `wN.txt` once to get everything, saving each worker three separate Reads for tokens/easings/voice:

```bash
mkdir -p /tmp/scene-dispatch
# Shared header: three global chunks (needed by every worker, identical content), computed once
(cd "$PROJECT_DIR" && cat design-system/chunks/tokens.css design-system/chunks/easings.js design-system/chunks/voice.md 2>/dev/null) \
  > /tmp/scene-shared.txt
# Then per-worker: shared header + that worker's Scenes YAML (template below), written to /tmp/scene-dispatch/w<N>.txt
```

**Scene workers** (each writes `compositions/scene_<N>.html`):

- N `Agent` calls (`subagent_type: "general-purpose"`, each `run_in_background: true`). prompt = the full contents of `agents/hyperframes-scene.md` + `## Dispatch context`, passed through verbatim. Top-level dispatch context fields: `SKILL_DIR` / `PROJECT_DIR` / `Worker ID` / `Captions: <enabled|disabled>` (= `group_spec.captions_enabled`) / `Dispatch packet: /tmp/scene-dispatch/w<N>.txt`, plus `## Tokens/easings/voice` (the shared header body) + a two-part `Scenes:` list (the packet contents).

  Copy every field in the **`Scenes:` list verbatim from `group_spec.json.groups[i].scenes[<sid>]`** (only that worker's 1-2 scenes): `scene_id` / `effects` / `rule_paths` / `assetCandidates` / `estimatedDuration_s` / `voicePath` / `blueprint` / `shared_element_bridge` (Tier-A, usually null) / `design_chunks` (contains absolute paths to the whole component library - the worker chooses by visual judgment) / `creative_brief` (the Phase 3 prose for that scene). Field semantics are in `agents/hyperframes-scene.md`.

  **`design_chunks: null`** (emit-chunks did not run / index.json missing) = prep already reported an anomaly; the worker should fall back to reading `./design-system/design.html` fully (adds ~30-90s per worker). This should not happen in the normal path.

After all subagents (scene workers + captions) return, run the preflight harness. Note that `check-compositions.mjs` **only scans `compositions/scene_*.html` according to `scene_ids` in `group_spec.json`** (scene-specific rules: root div contract / selector scoping / etc.). It **does not check `captions.html`** (`captions.html` uses the caption agent's own self-lint + structural grep + Step 7 finalize whole-project lint):

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/check-compositions.mjs \
  --hyperframes . \
  --group-spec ./group_spec.json)
# Tier-A bridge validation (only when group_spec.transitions[] contains tier:"a"; otherwise no-op exits 0):
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/transitions.mjs check-bridge \
  --hyperframes . \
  --group-spec ./group_spec.json)
```

`transitions.mjs check-bridge` deterministically validates that every Tier-A bridge has matching `data-bridge-id` elements in both the outgoing and incoming scenes (writes `bridge_check.json`). Visual alignment of the handoff pose cannot be statically checked and is left to Step 7 finalize seam snapshots.

Exit codes (same meaning for both scripts):

- 0 -> all compositions pass (blueprint anomalies do not block), continue to Step 7.
- 1 -> stderr names the violating scene + rule category (`check-compositions`) or missing/misaligned bridge elements (`check-bridge-continuity`); **go back to Step 6 and re-dispatch the affected worker** (do not Edit in the master agent - fix upstream).

### Step 7 - Assembly prelude + preflight gate + finalize (Phase 4c)

After Step 6 preflight (`check-compositions.mjs`) exits 0, the orchestrator first performs a **deterministic Bash prelude** (wait-bgm + assemble + inject/verify-transitions + sfx-verify + preflight), then dispatches one **repair finalize subagent** that covers visual QA -> in-place fixes -> render. Principle: deterministic prelude is all Bash; the agent only does snapshot visual QA + one in-place repair pass + render. Do not roll back and re-dispatch workers unless recomposition is needed. Deterministic steps moved into Bash: BGM on-disk check, assembly, **scene transition injection + verification**, SFX verification, lint/validate/inspect, and caption keep-out scan. `compositions/scene_N.html` is the worker source file; editing it means editing the source.

**(1) BGM wait + assembly prelude (deterministic, run directly in Bash):**

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

These four steps are all deterministic. **No agent hand-writes `index.html`, manually computes overlap, or manually runs `ls bgm.wav`**. See the header comments in each script for internal logic (`wait-bgm` is the single BGM on-disk check; `assemble-index` turns group_spec into the `index.html` track layout; when `inject-transitions` injects Tier-B transitions, it **only changes the `index.html` shell `data-start`/`data-duration`/`data-track-index` and never touches scene file roots**; `verify`/`sfx-verify` deterministically re-check). You only run the commands and branch by the exit codes below. `check-compositions` already ran in Step 6 and is not rerun here.

- assemble exit 1 -> it names a scene (root `data-duration` != group_spec, or scene file missing). This is a worker contract break (timing was fixed upstream and finalize cannot repair it) -> **go back to Step 6 and re-dispatch that worker**, then rerun this step.
- inject-transitions / verify-transitions exit 1 -> injector bug (normally impossible; prep already validated `transitions[]`) -> report for investigation, do not roll back workers.
- sfx-verify exit 1 -> assembler bug (normally impossible) -> report for investigation.

**(2) Preflight gate + compute snapshot times (deterministic, run directly in Bash):**

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/preflight-finalize.mjs --group-spec ./group_spec.json --hyperframes .)
```

preflight does everything the agent does not need to judge and writes it all into `finalize_brief.json`: warms a pinned `npx hyperframes@<version>` cache, runs lint/validate/inspect with that version and captures tails + summary counts, computes the snapshot timeline, when `captions_enabled` runs `captions.mjs keepout` static check for "foreground lower edge y <= 900", and runs `check-rendered-perception.mjs` for Puppeteer real-render geometry checks (including `cross-text-collision`, which detects collisions among multiple text bboxes). **Keep-out violations include ready-to-apply Edit strings** (`edit_old`/`edit_new`), so finalize can directly `Edit` them without reading the source or recomputing geometry. Brief fields (`preflight_clean` / `gates_clean` / `gates.*` / `bgm.*` / `caption_keepout.*` / `perception.*` / `anomalies[]` / `snapshot_times_s[]` / `npx_prefix` / `scenes[]`) and algorithm details are documented at the top of `preflight-finalize.mjs`.

**Exit codes (new behavior, orchestrator must read them)**:

- **exit 0** -> all gates pass -> proceed to (3) and dispatch finalize.
- **exit 2** -> **BLOCKING** - lint / validate / inspect has at least one real ERROR (`exit_code` is non-zero). **Do not** dispatch finalize and **do not** bypass with `--allow-gate-failure`. Read `finalize_brief.json.gates.<gate>.output_tail` to locate which scene and what kind of violation:
  - `text_box_overflow` / `canvas_overflow` / `container_overflow` -> worker estimated layout by intuition, but real wrapping / overflow failed. Usually **go back to Step 6 and re-dispatch that worker** (include the inspect selector + scene so the worker knows what collided and can use relative flow instead of fixed absolute placement); rare by-design overflow -> add `data-layout-allow-overflow="true"` to the element and rerun preflight.
  - `lint` / `validate` failure -> usually a scene file schema / selector / asset path issue. Inspect the tail to locate the file, `Edit` it, and rerun preflight.
  - To see how finalize handles these itself (for agent-flow debugging), rerun `preflight-finalize.mjs --allow-gate-failure`.
- **exit 1** -> preflight itself crashed (bad invocation / missing group_spec) - inspect stderr and fix the invocation.

**`anomalies[]` array** (scan it even if preflight exits 0): loud but non-blocking warnings. The most common current one is `perception_check_skipped` (Puppeteer is not installed locally, so real-render geometry checks such as cross-text-collision / depth-layer-ghost did not run; finalize snapshot visual QA becomes the only safety net, and a rate limit becomes an automatic no-go). Each anomaly includes `actionable_install_command`; copy it once to enable coverage next time.

**(3) Dispatch finalize subagent (repair mode - snapshot visual QA + one in-place fix pass + render):**

- `Agent` (`subagent_type: "general-purpose"`), prompt = full contents of `agents/hyperframes-finalize.md` + `## Dispatch context`:

  ```
  SKILL_DIR: <absolute path>
  PROJECT_DIR: <video project root>
  Render quality: high     # Or draft / standard, decided by the orchestrator
  Finalize brief: <PROJECT_DIR>/finalize_brief.json   # Preflight has already written it; agent reads once to get gate results + npx_prefix + snapshot_times_s
  Scenes:                  # One line per scene, copied verbatim from group_spec.json (for visual QA comparison + locating scene files to repair)
    - { scene_id, start_s, estimatedDuration_s, effects: [...], creative_brief: |
        <Phase 3 prose for this scene> }
  ```

  `index.html` is already assembled; gates + caption keep-out have already run; snapshot times have already been computed. **Normal path (`preflight_clean: true`)**: finalize skips Step 1+2+2.5, goes straight to snapshots (pass the brief's `snapshot_times_s` to `--at` all at once) -> visual QA -> one in-place repair pass for visible issues -> render (using the brief's `npx_prefix`) -> verify-render. **Exception path**: finalize branches by failure locations in the brief - gate failure -> inspect `output_tail`, locate, in-place Edit, rerun that gate; caption keep-out violation -> directly apply each `caption_keepout.violations[].edit_old/edit_new` (one at a time, without reading source files or recomputing geometry), then run `captions.mjs keepout` once to verify. The full failure-handling table + visual QA checklist are in the agent prompt. **When finalize repairs scene visual issues in place, it must never change the scene root `data-duration`** (= group_spec `estimatedDuration`, fixed upstream; changing it makes assemble cross-check fatal). Timing errors can only be fixed by returning to Step 6 and re-dispatching the worker.

Exit codes / behavior:

- finalize reports the mp4 (verify-render passed) + gate/snapshot status + scene files repaired in place -> complete.
- finalize STOP (**only when** a scene needs "recomposition" - the entire scene content is wrong / multiple primary items require real relayout / animation logic is too broken for one or two edits) -> orchestrator goes back to Step 6 and re-dispatches that worker -> **rerun (1) + (2) assembly and preflight** -> re-dispatch finalize. This is an exception path, not the default.

### Completion report

After completion, summarize for the user: key outputs for every phase (capture URL/section/asset counts, preset, archetype, scene count/total duration, worker grouping, transitions, gate status, scene files repaired in place, final mp4 path + bytes + duration). The complete per-phase field list is in "Design notes / Completion report fields" below.

---

## Resume table

Read `$PROJECT_DIR/context.log` and decide where to resume from using these states:

| State                                                                                                                             | Continue from                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| log missing or empty                                                                                                              | Full pipeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `capture/extracted/tokens.json` missing                                                                                           | Rerun Step 1 (capture + derive-context-pack + `build-design.mjs --no-emit`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tokens.json` exists, `design-system/inference.json` missing                                                                      | Rerun only the final `build-design.mjs --no-emit` step of Step 1 (deterministic, a few seconds)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `inference.json` exists, but `design.html` missing **or** `narrator_scripts.json` missing                                         | Step 1b/2 parallel fill-in: if `design.html` is missing, dispatch design-system; if `narrator_scripts.json` is missing, dispatch story-design; if both are missing, dispatch both together in the same message                                                                                                                                                                                                                                                                                                                                                                                   |
| `narrator_scripts.json` exists, `audio_meta.json` missing                                                                         | Step 3 (audio)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `audio_meta.json` exists, `section_plan.md` missing                                                                               | Step 4 (visual-design)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `section_plan.md` exists, `group_spec.json` missing                                                                               | Step 5 (prep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `group_spec.json` exists, `compositions/scene_*.html` missing **or** captions chain has not run (`caption_groups.json` missing)   | Step 5.5+6 (first run `captions.mjs group` -> `captions.mjs html` in Bash to produce `caption_groups.json` + `captions.html`; then in the same message, dispatch workers in parallel for whichever scenes are missing). **Criterion for captions having run = `caption_groups.json` exists** (whether it produced `captions.html` or legally skipped). Do not use missing `captions.html` as the criterion: a legal skip (all words cleaned out / missing `tokens.css` / no words) naturally produces no `captions.html`, and using it as the criterion would rerun and re-skip on every resume. |
| All `compositions/scene_*.html` exist + captions state is decided (file exists or skipped confirmed), `renders/video.mp4` missing | Step 7: first deterministically rerun assemble-index + sfx-verify + preflight-finalize (overwrite `finalize_brief.json` / `index.html` even if they already exist, because upstream scenes may have changed), then dispatch the finalize subagent                                                                                                                                                                                                                                                                                                                                                |
| `renders/video.mp4` exists                                                                                                        | Report completed and stop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## Design notes (for maintainers - master execution does not need to read this)

The following sections explain the "why" behind steps after those details were pushed down from the main flow. They are for skill maintenance; running the pipeline does not depend on this section.

### Directory shape

```text
./                            # workspace root
├── .claude/skills/
├── node_modules/  package.json
└── videos/<project-name>/    # PROJECT_DIR - HyperFrames project root
    ├── hyperframes.json  context.log
    ├── capture/              # hyperframes capture artifacts
    │   ├── extracted/        # tokens / design-styles / animations / fonts-manifest / asset-descriptions / video-manifest / visible-text
    │   ├── assets/           # media + svgs/ + fonts/ + videos/previews/ + contact sheets
    │   ├── screenshots/      # scroll-*.png + contact-sheet-*.jpg
    │   └── meta.json
    ├── design-system/        # build-design outputs (fed by capture): inference.json / design.html / chunks/ / fonts/
    ├── narrator_scripts.json  audio_meta.json  section_plan.md  group_spec.json
    ├── public/  assets/  compositions/  snapshots/
    └── renders/video.mp4
```

### sibling producer (Step 1b/2)

design-system and story-design both fork from capture and **do not read each other's output**, so start them in parallel in the same message. The `inference.json.site_dna` read by story-design is a stable value written by the Step 1 Bash phase; the later design-system rewrite of inference.json with `--style` does not affect it. Do not serialize story-design after design-system (the older artificial serial dependency has been removed).

### Captions gate (Step 4 vs Step 5)

The `Captions:` value passed to visual-design in Phase 3 is only an optimistic estimate computed from audio_meta (>=1 scene has wordsPath => enabled, biased toward reserving a bottom subtitle band in the plan). The authoritative gate is `group_spec.captions_enabled`, produced by Step 5 `prep.mjs`; mismatch is safe, because Step 6/7 keep-out always follows group_spec. Caption skin source: preset-provided `caption-skin.html` first, otherwise select by inference scoring (see the header of `captions.mjs html`).

### Completion report fields

Complete per-phase fields you may report after finishing (pick as needed):

- capture: Final URL / title / section count / asset count / fonts / animation, shader, Lottie, video manifest
- design-system: build-design.mjs stdout (palette / fonts / preset / component count)
- story-design / visual-design: archetype (story only) / scene count / total duration / one line per scene
- audio: TTS provider / voice id / BGM enabled, pending, provider, mode, log / total_duration_s
- prep: scenes / groups / total_duration_s / per-group scene_ids / transitions(type, direction, duration, tier) / copied asset count / anomalies
- captions: caption_groups.json.stats (groups/words/split) / selected skin / whether captions.html was generated / self-check result; or skipped reason
- scene workers: worker count / each worker's scene_ids, effects, blueprint / check-compositions passed, violations, anomaly count
- finalize: wait-bgm summary / assemble summary (clips, voice, bgm, captions, sfx counts) / inject-transitions summary (per boundary + track rearrangement) / preflight summary (pinned version, gates_clean, deterministic fix) / lint, validate, inspect status / snapshot visual QA one line per scene + seam / scene files repaired in place / verify-render mp4 path, bytes, ffprobe duration / quality / any re-dispatched worker
