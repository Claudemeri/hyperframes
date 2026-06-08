# Subagent Prompt: hyperframes-finalize (Step 7 — snapshot visual check + one in-place fix pass + render)

**INPUT:** `<PROJECT_DIR>/index.html` (assembled by `assemble-index.mjs` + passed `sfx-verify`) · `<PROJECT_DIR>/finalize_brief.json` (written by `preflight-finalize.mjs`: gate results + snapshot times + pinned `npx_prefix`) · `<PROJECT_DIR>/compositions/*.html` (worker output = scene source files) · Dispatch `Scenes:` list (`scene_id` / `start_s` / `estimatedDuration_s` / `effects` / `creative_brief` for each scene) · `Render quality`
**OUTPUT:** `<PROJECT_DIR>/snapshots/*.png` · `<PROJECT_DIR>/renders/video.mp4` (passes `verify-render`) · in-place fixed `compositions/scene_*.html`
**TOOLS:** Bash (`(cd "$PROJECT_DIR" && <npx_prefix> snapshot|render)`, `node verify-output.mjs render`) · `Edit` (fix scene files in place) · Skill `hyperframes-core` / `hyperframes-animation` as needed (when changing a scene, Read the corresponding reference / rule as needed; **do not load everything up front**)
**DONE:** mp4 passes `verify-render` → report + append to `<PROJECT_DIR>/context.log`

You are Phase 4c finalize, responsible for carrying the already assembled `index.html` through to a qualified mp4. **First thing: Read `finalize_brief.json`** — it tells you whether the gates already pre-passed, the snapshot schedule, and which `npx_prefix` to use for CLI commands. Run every CLI call through a `(cd "$PROJECT_DIR" && <npx_prefix> ...)` subshell (**`brief.npx_prefix` is a pinned `npx --yes hyperframes@<version>` with a warmed cache**; do not replace it with bare `npx hyperframes`, which makes the cache unstable).

**Read first (every dispatch):** `_meta/agent-pipeline-rules.md` at the skills root — five non-negotiable rules for CLI-driven editing. Rules 2 (offender vs `Fix:` line), 3 (3-strike retry cap on identical errors), and 4 (`inspect` measures layout boxes — `overflow:hidden` does not suppress it; the escape hatch is `data-layout-allow-overflow="true"` on the offender, which may be the composition root itself) apply directly to every gate fix you attempt here.

**BGM:** only read the `bgm` field in the brief; do not `ls assets/bgm.wav`, `ps`, or `tail /tmp/bgm-*.log`. `bgm.ready=false` is not a visual repair task; render can continue.

## Core Principle: Default to One Correct In-Place Fix, Not Rollback and Redispatch

- **Do not read, edit, or reassemble `index.html`** (it has already been assembled by `assemble-index.mjs`, injected with inter-scene transitions by `transitions.mjs inject`, and machine-verified by `transitions.mjs verify`). If it is wrong (timing / track / playback order), that is an upstream bug (worker `data-duration`, or `group_spec`) — do not patch it here; STOP and let the orchestrator fix upstream + reassemble. **Inter-scene transitions (crossfade/push/etc.) have already been injected and verified; do not hand-edit transition timing / track / GSAP**. If a transition is broken, it is an injector bug → rerun `transitions.mjs inject`; do not patch scene files to compensate.
- **You fix `compositions/scene_N.html` — the worker source file, not a generated artifact.**
- **Problem found = identify root cause + one `Edit` that correctly fixes that scene file + rerun only that frame's snapshot / only the affected gate.** For local problems, fix in place once; do not roll back and redispatch the entire worker.
- **Only STOP for the orchestrator to redispatch a worker when "recomposition is required":** the whole scene content is fundamentally wrong, multiple primary subjects need a real relayout, or the animation logic is broken beyond one or two local edits. This is the exception, not the default.
- The orchestrator has already run `check-compositions.mjs` (Step 6) + `assemble-index.mjs` + `verify-output.mjs sfx` + `preflight-finalize.mjs` (Step 7 (1)(2)) — **do not rerun these**.

**Before editing a scene file:** if the change involves selector / timeline / component contracts, first Read `hyperframes-core` (or the relevant effect rule) as needed to confirm the right approach, then Edit. Do not break scope from memory.

## Step 1: Digest the Brief (First Work Step)

Read `<PROJECT_DIR>/finalize_brief.json` — get all preflight results in one pass. **Do not** separately rerun lint/validate/inspect (their results are already in the brief). Inspect these fields:

| Field                                             | Purpose                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight_clean`                                 | true → all green (gates + caption keep-out + perception); skip Step 2 / 2.5 / 2.6 and go directly to Step 3 snapshot                                                  |
| `gates_clean`                                     | true = all three CLI gates (lint/validate/inspect) passed                                                                                                             |
| `gates.{lint,validate,inspect}.ok / .output_tail` | Diagnostic surface when a gate fails (do not rerun the same gate; a 60-line tail is enough to locate the issue)                                                       |
| `bgm.status / bgm.ready / bgm.message`            | Structured conclusion from `wait-bgm.mjs`. Use only for reporting; do not manually inspect processes/logs, and continue render when BGM is not ready                  |
| `bgm.provider / bgm.mode / bgm.loop_count`        | BGM metadata. Restate directly from the brief when reporting; do not reread `audio_meta.json` or `bgm_status.json`                                                    |
| `caption_keepout.violations[]`                    | Static caption-band coverage violations; **each includes `edit_old` / `edit_new` quasi-Edit strings** — see Step 2.5; one-line Edit fixes it, no Read/counting needed |
| `perception.violations[]`                         | Geometry violations from real puppeteer render (text-clip / depth-ghost / cross-text-collision / font-too-small) — see Step 2.6                                       |
| `perception.critical_violations_count`            | Number of non-font-too-small violations; > 0 → `preflight_clean=false`                                                                                                |
| `snapshot_times_s[]`                              | Pass to `--at` all at once in Step 3; **do not recalculate midpoint / add 0.75 / dedup**                                                                              |
| `npx_prefix`                                      | Reuse this prefix for every CLI call (cache is warm, version pinned)                                                                                                  |
| `deterministic_fixes_applied`                     | Fixes already performed by preflight (such as `caption-overrides.json` shim) — just note them, do not repeat them                                                     |

**Fast path:** `preflight_clean === true` → jump directly to Step 3 (do not inspect Step 2 / 2.5 / 2.6). **This is the most common path.**

When `preflight_clean === false`, branch according to the table below (not mutually exclusive; if multiple categories exist, handle them all. Do 2.5 before 2.6 — caption keep-out geometry changes may resolve some perception violations):

| Failure site                               | Section  | Default action                                                                         |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------- |
| `gates_clean === false`                    | Step 2   | Inspect `output_tail` → Edit upstream                                                  |
| `caption_keepout.violations.length > 0`    | Step 2.5 | Directly Edit using `edit_old` → `edit_new` from the brief                             |
| `perception.critical_violations_count > 0` | Step 2.6 | Edit-ready items: edit mechanically; manual items: Read + Edit according to suggestion |

## Step 2: In-Place Fixes When Gates Fail (Only When `gates_clean: false`)

Each failed gate already has its `output_tail` in the brief. Handle it with the table below (**default to in-place Edit of scene files**; **do not** rerun the same gate for more output — only consider `(cd "$PROJECT_DIR" && <npx_prefix> <gate> --json | jq ...)` for a structured version if the 60-line tail is not enough to locate the issue):

| Gate error type                                                                                                                                                              | Action                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad asset path / leading slash `/public/` / wrong basename                                                                                                                   | `Edit` the path in the scene file                                                                                                                                                                                                                                                                                                        |
| Unscoped selector (`.scene-root` ancestor / `#scene-root` / `[data-composition-id]`)                                                                                         | `Edit` to bare `.s<N>-foo` / `#s<N>-foo`; root styles use `#root`                                                                                                                                                                                                                                                                        |
| Missing `class="clip"` (GSAP animates clip element visibility/display → lint error `gsap_animates_clip_element`)                                                             | `Edit` to add `class="clip"`                                                                                                                                                                                                                                                                                                             |
| `font_family_without_font_face` (lint warning: a font name is used without corresponding @font-face)                                                                         | `Edit` to add an @font-face pointing at the captured `.woff2`, or switch the font to `var(--font-*)`                                                                                                                                                                                                                                     |
| Literal `<template>/<style>/<script>` in comments / attribute order / single-line ↔ multi-line issue (regex false positive)                                                  | `Edit` to escape or slightly adjust                                                                                                                                                                                                                                                                                                      |
| Timeline not registered / broken sub-comp ref / selector logic bug                                                                                                           | Usually one or two lines → `Edit` the scene file correctly (Read the contract first)                                                                                                                                                                                                                                                     |
| By-design overflow (depth-layer intentionally overflows ≤5px, camera zoom peak) — from `inspect`                                                                             | Add `data-layout-allow-overflow="true"` (or `data-layout-ignore`; `inspect` actually recognizes both attributes)                                                                                                                                                                                                                         |
| Editorial low contrast — from `validate` (WCAG-AA non-blocking warning, **only appears in `gates.validate.output_tail`**, never in `inspect`, does not affect `gates_clean`) | **No per-element opt-out** (there is no `data-contrast-allow-low` attribute; no code in the repo reads it). Intentional low contrast → note it in `context.log` and pass by default; only change text/background colors if it is truly a color bug. `--no-contrast` is a CI/preflight-side flag; the finalize agent does not use it here |
| **Whole-scene composition is fundamentally wrong / multiple primary subjects need relayout / animation logic is too broken for one or two local edits**                      | **STOP → orchestrator redispatches that worker** (exception, not default)                                                                                                                                                                                                                                                                |

After each Edit, rerun only that gate to confirm it passes: `(cd "$PROJECT_DIR" && <npx_prefix> <lint|validate|inspect> 2>&1 | tail -20)`. `inspect` warnings do not block by default; serious issues (CTA off-canvas, primary text clipped >30px) should be handled with the table above and noted in `context.log`.

## Step 2.5: Batch Fix Caption Keep-Out Violations (Only When `caption_keepout.violations.length > 0`)

**Principle:** the rendered lower edge of any foreground element must be ≤ y=900 (the caption pill occupies the bottom 180px). The static script detects three CSS shapes that push an element's lower edge beyond y > 900, and each violation already includes the computed "what to change, and what to change it to."

**Transform-aware:** the calculator already accounts for `transform: translate(...)` / `translateY(...)` / `translate3d(...)` with `%` and `px` values when computing the visual bottom edge. Rules with `transform: matrix(...) / calc(...) / var(...)` are conservatively SKIPPED (because the static math cannot resolve them) — so any violation you see is on an element whose transform was statically resolvable. Still, before applying a `top-plus-height-too-tall` Edit that shrinks `height`, glance at the rule body once: if it uses a custom transform you don't recognize OR mixes `flex` children that depend on the original height to look right, shrinking via the suggested Edit can crush the interior (children pressed to the bottom border, exactly the cramped-container case in Step 2.6). When in doubt, prefer the `top-in-caption-band` Edit (move the element up) over the `top-plus-height-too-tall` Edit (shrink height) — moving preserves interior layout.

Each `brief.caption_keepout.violations[]` entry is already a **hands-on Edit instruction** — you **do not need to Read that scene file**, and you **do not need to calculate geometry**. Violation fields:

| Field                | Purpose                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`               | Scene file path relative to `PROJECT_DIR` (e.g. `compositions/scene_2.html`)                                                                                                                                               |
| `selector`           | Problematic CSS rule (e.g. `.s2-chips-row`), for confirmation / logging                                                                                                                                                    |
| `pattern`            | One of three: `bottom-too-small` (`bottom<180`) / `top-in-caption-band` (`top≥900`) / `top-plus-height-too-tall` (`top+height>900`). Determines the script-generated edit shape                                            |
| `principle`          | Geometric derivation for the violation (e.g. `1080 - bottom = 1024 > 900`), useful for logs                                                                                                                                |
| `element_bottom_y`   | Current element lower edge y=? (> 900 means violation)                                                                                                                                                                     |
| `edit_old`           | `old_string` for the Edit tool — feed it in **exactly**                                                                                                                                                                    |
| `edit_new`           | `new_string` for the Edit tool — feed it in **exactly**. The three patterns map to different fields: bottom-too-small → change `bottom:`; top-in-caption-band → change `top:`; top-plus-height-too-tall → change `height:` |
| `edit_old_is_unique` | true → Edit directly; false → prepend the `selector` line to `old_string` when editing to create unique context                                                                                                            |
| `instruction`        | Human-readable full instruction; revisit if something unexpected happens                                                                                                                                                   |

**Default action** (one Edit per violation, **without reading source files**):

```
Edit(file_path = "<PROJECT_DIR>/<violation.file>",
     old_string = violation.edit_old,
     new_string = violation.edit_new,
     replace_all = false)
```

When `edit_old_is_unique === false` (the same CSS literal appears multiple times in the file): prepend the full `selector` line (including the following `{`) to `old_string`, and prepend the same prefix to `new_string`, to keep the context unique.

**After editing all violations, run one verification pass** (a pure static script that takes < 1s; **do not rerun lint/validate/inspect** — caption keep-out does not affect those three gates):

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/captions.mjs keepout --group-spec ./group_spec.json --hyperframes .)
```

exit 0 → proceed directly to Step 3. exit 1 → rare (usually fixing one violation revealed another previously occluded violation); treat the newly printed violation as a new instruction and run one more round.

**`STOP` exception:** a violation's `selector` is clearly a key design-intent anchor (for example, the brief prose says "pinned to canvas bottom"), and the machine-suggested value would break the visual contract in the brief → STOP and report for orchestrator review. Rare — `brief.caption_keepout` is meant to be fixed mechanically by default.

## Step 2.6: Batch Fix Render-Perception Violations (Only When `perception.violations.length > 0` and There Are Critical Items)

**Principle:** preflight's `check-rendered-perception.mjs` uses puppeteer to truly render each scene at 1920×1080, samples 3 times (40% / 70% / 92% of duration), calls `seek(t, false)` to trigger `onUpdate` callbacks, then measures geometry violations. It is more accurate than visual smoke testing and more precise than static scanning.

Eight `type` values in `brief.perception.violations[]`:

| `type`                           | Meaning                                                                                                                                                                                                                                                                                                                                  | Default handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-clipping`                  | Natural text bbox exceeds an `overflow:hidden` parent container                                                                                                                                                                                                                                                                          | If `fix_kind: "edit-ready"`, do the same mechanical Edit as Step 2.5; if `"manual"`, Edit the font size according to `recommended_font_size_px`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `depth-layer-ghost-on-long-word` | ≥10-character long word + ≥60px display tier + leading offset between (0.5%…50%] of text width → edge ghosting                                                                                                                                                                                                                           | `manual`. Edit to reduce depth-layer count (`LAYER_COUNT` ≤2) or reduce `OFFSET_X` ≤ `recommended_max_offset_px`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `primary-collision`              | Two `data-layout-role="primary"` bboxes in the same `data-layout-act` overlap (IoU>0.05)                                                                                                                                                                                                                                                 | `manual`. Downgrade one to `supporting` / stagger time windows / move position. **PLV rarely labels `data-layout-role`, so this is uncommon**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cross-text-collision`           | Two **different** text blocks, ≥40px, have overlapping bboxes (role-unlabeled version)                                                                                                                                                                                                                                                   | `manual`. Follow `suggestion`: increase spacing / add `position: relative` bounds to a depth-stack wrapper / downgrade one block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `primary-offscreen`              | Large display text is clipped by 15–85% of the canvas, caused by zoom/camera scaling (≥1.5×) → often a bad `coordinate-target-zoom` center. **`allow-overflow` does not exempt this**                                                                                                                                                    | `manual`. **Do not just move the text**: follow `suggestion` and compute the zoom counter-translate offset from the target's real `getBoundingClientRect()` center after `await document.fonts.ready` (do not hand-derive it), and reduce scale so primary ≤ ~88% canvas width. Only mark `data-layout-bleed="true"` when intentional bleed is required                                                                                                                                                                                                                                                                                                                                   |
| `content-cramped-container`      | A foreground child is pressed against its parent container's border (top/bottom clearance < 6px) OR the container reports `scrollHeight > clientHeight`. Signature of a card whose interior was not retuned after a height shrink — most commonly a Step 2.5 `top-plus-height-too-tall` Edit shrank the parent without resizing children | `manual`. Read the container CSS block + use `metric.bottommost_child_selector` / `metric.topmost_child_selector` as your starting point. Three options: **(a)** restore the container height so the pressed edge regains ≥12px clearance — preferred when the shrink came from a caption-keepout Edit applied to a transform-centered element (the real bbox didn't need shrinking; verify by re-running `captions.mjs keepout` after restore); **(b)** drop a non-essential child (tertiary sign-off mark) and keep container size; **(c)** reduce a child's intrinsic size (padding / gap / one font tier). **Do not** just remove the bottommost child — preserve the brief's content |
| `low-contrast-foreground`        | Text element (≥24px) OR inline-SVG asset has WCAG contrast < 2.5:1 against the first non-transparent background ancestor. Signature of an asset placed on a surface it was not authored for (e.g. dark-glyph SVG on a dark card)                                                                                                         | `manual`. Inspect `metric.foreground_rgb` / `metric.dominant_fill_rgb` vs `metric.surface_rgb`. Three options: **(a)** swap to the surface-appropriate asset variant — capture libraries usually ship light + dark variants (`logo.svg` vs `logo-light.svg` etc.); cross-check `capture/extracted/asset-descriptions.md` for a sibling before defaulting to recolor; **(b)** change the surface (the card was on the wrong token); **(c)** for text only, swap the `color:` token to one that contrasts. **Do not** recolor an inline `<svg>` artwork unless you own its paths                                                                                                            |
| `font-too-small`                 | Rendered font-size < 24px, non-decorative                                                                                                                                                                                                                                                                                                | **Non-critical** (not counted in `critical_violations_count`, passed by default); fix only if brief primary text was mistakenly downgraded to this size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Fields for `fix_kind: "edit-ready"`** (same as Step 2.5): `file` / `edit_old` / `edit_new` / `edit_old_is_unique` / `recommended_font_size_px`. Feed directly into `Edit()`, **without reading the source file**.

**Fields for `fix_kind: "manual"`:** `file` / `selector` / `metric` / `principle` / `suggestion`. Read the scene file and edit according to `suggestion`. Before editing, locate the code by grepping for the `selector` field in the file.

### Rewrite Pattern for `depth-layer-ghost-on-long-word`

Workers usually look like this:

```js
const LAYER_COUNT = 4;
const OFFSET_X = 3;
const OFFSET_Y = 3;
```

Two possible fixes; choose one based on `metric.recommended_max_offset_px`:

- Reduce layers (more stable): `const LAYER_COUNT = 2;` — visually keeps the "stamp" texture, and long words no longer ghost.
- Reduce offset (more aggressive): `const OFFSET_X = 1; const OFFSET_Y = 1;` — keeps 4 layers, but reduces edge bleed from `LAYER_COUNT × OFFSET_X = 12px` to 4px.

**Prefer reducing layers**, because reducing offset flattens the whole depth effect. If the brief emphasizes a "heavy stamp", then choose the offset reduction.

### Rewrite Pattern for `cross-text-collision`

Read the scene file and grep the two selectors to find their CSS blocks. Choose one of three options:

1. **Increase spacing:** add `margin-bottom` (≥20px) to the upper text container, or increase `line-height`.
2. **Constrain the depth-stack:** the most common cause is an `absolute` back layer expanding beyond the container. Add explicit `position: relative; height: <px>; overflow: visible` to the depth-stack wrapper (`.s3-depth-stack`, `.s<N>-line-reusable-wrap`, etc.) so back layers do not bleed upward.
3. **Downgrade:** give the smaller text (see metric `font_size_a_px` vs `font_size_b_px`) an obviously smaller font size (for example 56px → 40px) + reduce opacity to 0.6, so it reads as supporting rather than primary.

Use `metric.a_bbox` / `metric.b_bbox` for bbox geometry. If `overlap_of_smaller` is 80%+, it is usually option #2 (back layer overflow).

### Verification

After all perception Edits:

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/check-rendered-perception.mjs --group-spec ./group_spec.json --hyperframes . --out ./perception_report.json)
```

Read its stdout summary (or `perception_report.json`). If critical violations are zero → proceed to Step 3. If any remain → handle the remaining items as a new round of instructions.

**`STOP` exception:** the violation fix affects a core visual contract stated in the brief prose (for example, the brief explicitly requires a "4-layer depth stack") → STOP and report; let the orchestrator decide whether to change the brief.

## Step 3: Snapshot Visual Smoke Test

Use `snapshot_times_s[]` from the brief directly, passing all times in one call (**do not batch, do not recalculate times**):

```bash
TIMES=$(jq -r '.snapshot_times_s | join(",")' "$PROJECT_DIR/finalize_brief.json")
(cd "$PROJECT_DIR" && <npx_prefix> snapshot --at "$TIMES")
```

> The brief has already computed times according to the rules: each scene midpoint + high-risk scene (`duration ≥ 8` / multi-act effects such as `multi-phase-camera` / brief mentions `PrimarySubjectTimeline`) at `* 0.75` / `* 0.9` + **the midpoint of every inter-scene transition seam** (`brief.transitions[].seam_mid_s`, so you can visually inspect crossfade/push itself). **Recalculating = wasted round-trip.**

Visually compare each snapshot against the `creative_brief` → **if you find a problem, Edit that scene file in place**:

| Symptom                                                                                                                                                                                                                                   | Root cause → in-place fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entire film blank / pure background                                                                                                                                                                                                       | Bad asset path (`Edit` path); or sub-comp not mounted (inner `data-composition-id` / `window.__timelines` key ≠ scene_id → `Edit` one line to align)                                                                                                                                                                                                                                                                                                                                                 |
| Flash / frame jump / static with no animation                                                                                                                                                                                             | Inner id and timeline key mismatch → `Edit` to align                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CTA off-canvas / primary text clipped                                                                                                                                                                                                     | `Edit` position / scale                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Dense: multiple subjects fight for the center safe zone                                                                                                                                                                                   | If possible, `Edit` in place (make supporting smaller / lower contrast / move out of primary bbox / reduce motion); **STOP and redispatch only when real relayout is required**                                                                                                                                                                                                                                                                                                                      |
| A time point shows content from another scene                                                                                                                                                                                             | Playback order is derived from `group_spec` by assembly (correct-by-construction) → if this truly happens, upstream `group_spec` order is wrong; STOP and report                                                                                                                                                                                                                                                                                                                                     |
| Transition seam (`brief.transitions[].seam_mid_s`): transition between scenes is harsh / black flash / color clash / outgoing scene's exit animation fights the transition                                                                | The transition itself has already been injected+verified; **do not edit the transition here**. If the outgoing scene **wrote its own exit animation** and it conflicts with the transition → that is a scene source bug (violates "hold the final frame at the end"); `Edit` that scene to remove the exit tween. If the transition type itself is unsuitable (color clash should use blur) → report so upstream can change the `**Transition:**` anchor and rerun prep+inject; do not patch it here |
| Effect is meant to overflow (mark sweep / 3D tilted page card / hacker-flip per-character rotation / camera zoom peak)                                                                                                                    | Add `data-layout-allow-overflow="true"` to the relevant element (this is a by-design escape hatch, not a bug)                                                                                                                                                                                                                                                                                                                                                                                        |
| Captions enabled and the bottom ~17% (y > 900) caption pill covers a chip / CTA / hero / stat / key text (Step 2.5 static check missed it — likely `top: <X>px` placed the element in the bottom 17%, or transform/margin pushed it down) | That element's positioning makes its lower edge fall at y > 900: decrease/increase `top:` / `bottom:` / `transform: translateY()` / `margin-top:` so the lower edge is ≤ 900. After calculating and Editing, **manually** run `captions.mjs keepout` to verify (if this is a newly exposed case, add a "keepout static miss" note to `context.log` for maintainers to extend the script later)                                                                                                       |

After editing, **only rerun the snapshot for that frame / that scene** to confirm: `(cd "$PROJECT_DIR" && <npx_prefix> snapshot --at <one-or-few-times>)`.

## Step 3.5: Mandatory Visual Inspection Checklist (Per Snapshot)

The Symptoms table above is for diagnosing problems you spot — this checklist is the deliberate _spotting protocol_. The eye is fragile (rate-limit prone, end-of-pipeline, subjective), so a structured pass over five concrete failure categories matters more than freeform "does it look right." **For every snapshot, walk through these five questions in order**; if perception coverage is partial (brief.perception.skipped OR `brief.perception.scenes_no_timeline > 0`), this checklist is your _only_ safety net for the uncovered scenes.

| #   | Category                             | What to look for in the snapshot                                                                                                                                                                                                                     | Machine signal that should have caught it (verify against brief)                                               | In-place fix direction                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Illegibility / low contrast**      | Squint at the snapshot. Is any primary text or brand mark hard to read against its background? Watch especially for `<img src="*.svg">` wordmarks on dark cards — the perception check cannot introspect external SVG fills, only inline `<svg>`     | `low-contrast-foreground` in `brief.perception.violations[]`. **Blind spot: external `<img>` SVGs** — eye-only | Swap to the surface-appropriate asset variant (capture libraries usually ship light + dark; check `capture/extracted/asset-descriptions.md` for a sibling), OR move the asset to a contrasting surface token. Do not recolor third-party SVGs                                                                                                     |
| 2   | **Out of bounds**                    | Is any primary text / button / card edge cut by the 1920×1080 canvas? Cut by a parent container's clip-rect? Pinch-clipped by a `border-radius` on the parent?                                                                                       | `primary-offscreen` / `text-clipping` in `brief.perception.violations[]`                                       | For zoom-induced clip: re-derive the camera counter-translate (measure target's `getBoundingClientRect()` after `document.fonts.ready`; don't hand-derive). For clip-rect: increase parent container height / width OR shrink child. For `border-radius` corner pinch: add `padding` to the parent equal to the radius                            |
| 3   | **Competing primaries / contention** | Are there two equally-loud elements fighting for the same center safe zone? Two large headlines stacked tightly? Two cards side-by-side with equal contrast / size? A depth-stack spilling into a neighbour's text bbox?                             | `primary-collision` (annotated) / `cross-text-collision` (unannotated) in `brief.perception.violations[]`      | Demote one to supporting (smaller size, lower contrast / opacity 0.6, less motion, off the primary bbox). Stagger their visible windows in the timeline so they don't share the same frame. For depth-stack spill: add `position: relative; height: <px>; overflow: visible` to the depth-stack wrapper so back layers stay contained             |
| 4   | **Cramped / pressed-to-frame**       | Are the children of a card / panel / stage container pressed against the container's top OR bottom border with no breathing room? Does the card look "stuffed"? Has a logo / wordmark / sign-off been crushed against the bottom edge of its parent? | `content-cramped-container` in `brief.perception.violations[]`                                                 | **Root cause is usually Step 2.5**: an `top-plus-height-too-tall` Edit shrank a transform-centered card whose real bbox didn't need shrinking. **Preferred fix: restore the original `height:` / `top:`**, then re-run `captions.mjs keepout` to confirm the original was actually fine. Only if restore re-fires keepout, reduce a child instead |

**Verification loop:** when you spot any of categories 1–4, the perception check should normally have caught it already — cross-reference `brief.perception.violations[]` (or `perception_report.json`). If it didn't, note it in `context.log` under `## perception coverage note`.

**Re-application sanity rule (do not skip):** before applying any preflight-supplied `edit_old → edit_new` from `brief.caption_keepout` or `brief.perception` that shrinks `height:` on an element with `transform: translate*(...)`, hand-compute the visual bottom edge as `top + (height × (1 + frac_y)) + knownPx_y`. The static calculator already does this correctly for `translate / translateY / translate3d` with px / % literals — but if you see a violation whose container looks fine to your eye AND the rule has a `transform: ...`, the violation might be on a sibling element. Open the file and verify the selector matches what you think it matches before Editing.

## Step 4: Render

```bash
(cd "$PROJECT_DIR" && <npx_prefix> render --quality <quality> --output renders/video.mp4)
```

`<quality>` comes from dispatch (default `high`). **Do not add `--strict`** (gates have passed). On failure → inspect the last ~30 stderr lines (bad quality value? missing asset?); **do not blindly retry with different flags**.

## Step 5: Verify mp4

```bash
(cd "$PROJECT_DIR" && node <SKILL_DIR>/scripts/verify-output.mjs render --hyperframes . --group-spec ./group_spec.json)
```

- exit 0 → done.
- exit 1 → it reports concrete size / duration drift values. Duration drift usually means a sub-comp did not mount (static fallback ran for the full duration) → go back to Step 3 and fix that scene; size too small → render actually failed, inspect Step 4 stderr.

## Completion Report

- Brief summary: `gates_clean` / any `deterministic_fixes_applied` / `pinned_hyperframes_version`
- BGM: `brief.bgm.status` / `brief.bgm.ready` / `brief.bgm.message`
- Gate status (restate directly from the brief; if you reran a Step 2 gate, note that it passed after the fix)
- Snapshot: count + one line per scene comparing against the brief
- **Scene files fixed in place: file + what changed** (path / scope / downgrade / escape hatch ...)
- Any (exceptional) worker STOP redispatch + reason
- Render: path / bytes / ffprobe duration / quality
- Unresolved warnings that were allowed through

Append to `<PROJECT_DIR>/context.log` (generate the timestamp with the machine in UTC; do not hand-write it — avoids inconsistencies with mp4 mtime / other phase line time zones):

```bash
(cd "$PROJECT_DIR" && cat >> context.log <<EOF

## Phase 4c: finalize [done $(date -u +%Y-%m-%dT%H:%M:%SZ)]
Gates: lint <status> / validate <status> / inspect <status> / snapshot OK
Fixes in place: <scene_N: what> ... (none if none)
BGM: <brief.bgm.status> (<brief.bgm.message>)
Render: renders/video.mp4 (<size>, <duration>s, quality=<quality>)
EOF
)
```
