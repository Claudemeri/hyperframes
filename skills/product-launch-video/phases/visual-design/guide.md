## Flow Overview

1. **All inputs are already inlined in dispatch** (`## Effects catalog` / `## Blueprints index` / `## SFX library` / `## Design rules` [full text of 4 rules] / `## Design chunks` [`index.json` + actually present hints/voice/tokens/easings] / `## Narrator scripts` / `## Audio meta`) - **use them directly; do not Read from disk**
2. For each scene: choose effects from `## Effects catalog` (timeline layering order; count rules in §2), decide Continuity, write anchor block + 8 prose requirements; in prose, describe desired visual components by **role** ("a stat block", "a framed quote"), while the worker chooses concrete components from the `## Design chunks` library
3. Run validator until exit 0

---

## 1. Inputs

### `narrator_scripts.json`

- Scene-level: `sceneNumber`, `sceneName`, `narrativeIntent.{type, narrativeRole, keyMessage, persuasion, emotionalBeat}`, `transition.{continuity, intent, sharedMotif?, description}` (`continuity` copies directly to `**Continuity:**`; `intent` translates to `**Transition:**` registry type using the "Transition: translation" table; when `intent: morph`, `sharedMotif` -> `**Bridge:**` anchor), `assetCandidates[]` (each has `path` + `description`), `estimatedDuration` (strip trailing `"s"` -> float)
- Top-level: `narrativeArchetype` + `emotionalArc`, which influence whole-film pacing

### `## Design chunks` - Brand Input (inlined; do not read `design.html`)

Chunks are split by Phase 1b `emit-chunks.mjs` and **already inlined in the dispatch `## Design chunks` block**: full `index.json` + actually present `composition-hints.md` / `voice.md` / `tokens.css` / `easings.js` (chunks absent from the preset have `*_file=null` and do not appear in the block).

**Whenever this guide says "find X in `## Design chunks`", do not read from disk.** Plan does not touch `design.html` or component HTML bodies.

> **Positioning (core):** `## Design chunks` is the brand's **style reference library**, not a contract for the plan. It only answers "what does this brand look like" - palette (tokens), motion curves (easings), DOM text register (voice), and a set of **paste-ready components**. Visual **authority lives in `## Effects catalog` (animation), `## Blueprints index` (scene skeletons), and `## Design rules` (design judgment)**; chunks only make the result **look like this brand**. **Plan does not pre-cite components, declare surfaces, or filter components** - it describes desired structures by **role / purpose / intent** in prose, and Phase 4b worker chooses concrete components from the full library by visual judgment.

Plan uses chunks in these ways:

1. Inspect `chunks/index.json` (~1-2 KB) -> get `preset` name + component library list (`components[]`, each `{id, file}`). **Only use this to know what components exist in the preset**, so prose can refer to them by role ("use a stat-stamp-like number block"). No need to map each one, cite ids, or compute surfaces - worker chooses after seeing actual render.
2. Optionally inspect `chunks/composition-hints.md` (only when `index.json.hints_file != null`) -> preset's own **composition / material / color preferences** (background preference, 60-30-10 distribution, signature materials). Fold it into prose as style reference for palette / composition; worker uses it when implementing colors. This is taste guidance, **not** a hard "violation = render failure" contract.
3. Optionally inspect `chunks/tokens.css` (~1-2 KB) -> available role tokens in `:root` (`--canvas` / `--ink` / `--brand-*` / preset-private aliases like `--paper` / `--blue` / `--cream`) - informs descriptions of 30% middle layer and pain-scene palette.
4. Optionally inspect `chunks/easings.js` (~0.5 KB) -> whether role keys `EASE.entry / emphasis / exit / drift` are present, deciding which ease intents to cite in prose.
5. Optionally inspect `chunks/voice.md` (~0.5 KB, only when `voice_file != null`) -> this preset's DOM text register (strip / case / line breaks / inline `<em>`...). **Worker receives full voice.md through a dedicated channel and applies it by default**, so plan **does not need** to promise it scene by scene; mention it only for a **special application / risk** in that scene (e.g. "hero resolves as one-line UPPERCASE stacked words"). Plan does not write rewritten English copy (that is worker work).

No need to read `chunks/type-roles.md` -> named text role directory (worker lookup table for inline text styling). Plan does not cite role ids; it describes by role name ("hero display", "body lede").

**Do not read:** component HTML bodies (`chunks/components/<id>.html`) - Phase 4b worker owns that. **Do not read** legacy `design.html` (replaced by chunks).

**Plan references by role / purpose / intent, not literal values.** See §3 guidance:

| Name this                                              | Do not copy                                    |
| ------------------------------------------------------ | ---------------------------------------------- |
| **Role** (canvas / surface / accent / ink)             | concrete hex (`#e4ff97`)                       |
| **Purpose** (display / body / mono)                    | concrete font name (`Instrument Serif`)        |
| **Intent** (`EASE.entry` / `DUR.med`)                  | concrete curve (`power3.out`)                  |
| **Component role** ("a stat block" / "a framed quote") | component id / internal HTML / `<style>` block |
| **Voice register** ("UPPERCASE triplet")               | rewritten English copy (worker work)           |

### Do Not Read

- `capture/` (Phase 2 territory; assets pass through `assetCandidates`)
- `effects-catalog.md` / `blueprints-index.md` / `rules/*.md` (already embedded in dispatch as `## Effects catalog` / `## Blueprints index` / `## Design rules`)
- `chunks/*` from disk (already embedded in dispatch `## Design chunks`)
- blueprint full text (`blueprints/<id>.md`; build agent owns it)
- sidecar JSON / fonts directory under `design-system/`
- `design-system/design.html` (old contract; now replaced by `chunks/`)
- `chunks/components/<id>.html` body (plan only names role; component HTML is Phase 4b)

---

## 2. Hard Contracts (machine-checked)

**Whole-file shape (mandatory):** `section_plan.md` contains **only** an optional single-line H1 title + a sequence of `## Scene N:` blocks, **nothing else**. **Do not write a project-level preface / "system commitments" / project-level commitments / cross-scene summary** - downstream never reads it: `prep.mjs` starts splitting from the first `## Scene`, validator only traverses scene blocks, and workers are forbidden to read `section_plan.md` (they receive per-scene `creative_brief` sliced by prep). Any paragraph before the first `## Scene` = dead bytes written but never read, and validator errors. Global invariants reach workers through **two real channels**: 1. prose inside the relevant scene; 2. dedicated channels (`voice_file` / `Captions` flag / `tokens.css` / `easings.js`). The "restatement" before writing (§4 Step 0) happens **in your head only**; never write it into the file.

Each scene in `section_plan.md` is one block, in the same order as `narrator_scripts.json`:

```markdown
## Scene <N>: <sceneName>

**Effects:** [`<rule-id>`, `<rule-id>`, ...]
**Duration:** <X.XXs>
**Continuity:** break | continue
**Blueprint:** based-on `<id>` | extended `<id>` | composed <- optional (soft), see below
**Transition:** <type> [DIRECTION] [<dur>s] <- optional (soft); how this scene is entered, see below
**Bridge:** `<bridge-id>` <- only when **Transition:** shared-element (Tier-A morph); cross-scene element logical name, see below
**SFX:** <- optional (soft); omit entire section when unused; multi-line bullet list below
**PrimarySubjectTimeline:** <only for multi-act / dense multi-subject scenes>
**Handoff:** <only for multi-act / dense multi-subject scenes>

<prose body - first sentence is §4 item 1 emotional footnote - see §4>
```

**Order inside the block is mandatory, and PrimarySubjectTimeline / Handoff must appear after all anchors and before prose** (immediately after SFX block). Reason is mechanical: `prep.mjs` defines `creative_brief = all text after the last recognized anchor`, and it recognizes `SFX` but **does not recognize** `PrimarySubjectTimeline` / `Handoff`; therefore those two lines must come after SFX so they enter the worker brief. If placed before SFX, they get sliced away and worker never receives them. Rules: 1. all `**Anchor:**` lines (including SFX bullet block, PST, Handoff) are grouped at the top; 2. only then comes free prose, whose **first sentence** is the emotional footnote (§4 item 1, "the dividing line between real plan and generic AI output"); 3. once prose starts, **no more `**Anchor:**` lines** (interleaving = validator fatal). For multi-act scenes, the brief may start with `**PrimarySubjectTimeline:**` followed immediately by emotional footnote; that is expected.

`validate.mjs section` enforces (hard):

- **Effects:** 2-5 backtick-wrapped rule ids, comma-separated inside brackets; each id must be an existing rule under `hyperframes-animation/rules/` (the validator actually checks this). Normally cite only from dispatch `## Effects catalog`; order is timeline-layering order.
- **Duration:** float seconds (source in §1)
- **Continuity:** `break` or `continue`; **Scene 1 is always `break`**. Copy story-design `transition.continuity` (already fixed by `intent`: `morph` => `continue`, others => `break`). **`continue` <=> this scene has `**Transition:** shared-element`** (see Transition hard contract below)
- Required anchors each stand alone on their own line, with no surrounding text; missing any required anchor -> downstream fatal -> rerun Phase 3
- **PrimarySubjectTimeline + Handoff:** required for multi-act scenes or scenes where action/payoff + proof/supporting subject share the frame. Missing either -> validator fatal. **Position:** immediately after SFX block and before prose (machine reason in template note above - they must enter `creative_brief` for worker)
- **Block order:** all `**Anchor:**` lines (including SFX bullets, PrimarySubjectTimeline, Handoff) must precede free prose; any `**Word:**` anchor line after prose begins -> validator fatal (interleaving makes worker brief unpredictable)
- **File-level:** no project-level preface / commitments section before the first `## Scene` (only one H1 title allowed) -> validator fatal (see whole-file shape above)
- **Transition** (soft / if present): type must be in TRANSITION-REGISTRY vocabulary; direction is only legal for directional type (`push-slide`); duration `0 < dur <= 2.0s`. **Continuity <=> Tier-A is enforced both ways:** `Continuity: break` cannot name Tier-A (`shared-element`); conversely `Continuity: continue` **must** name Tier-A `shared-element` (omitting `**Transition:**` and accepting Tier-B default also violates) -> both are validator fatal
- **Bridge** (soft / Tier-A only): appears only when `**Transition:** shared-element`, value is one backtick-wrapped kebab-case logical name; `shared-element` must pair with `**Continuity:** continue` (otherwise downstream prep fatal - both scenes must share a worker to write the shared element). Bridge on a non-shared-element scene -> validator warning/ignore

**Blueprint anchor (soft - validator does not require, strongly recommended):**

- `based-on <id>` - fully adopt a blueprint (`Effects` list = all ids in the blueprint `uses`, order may change)
- `extended <id>` - adopt a blueprint but add effects (`Effects` includes all blueprint `uses` + 1-3 extra effects)
- `composed` - not based on any blueprint, freely combine effects catalog
- **Omitting the line = equivalent to `composed`**

Value of writing Blueprint anchor: (1) forces plan agent to explicitly commit to "using / not using blueprint", avoiding vague half-use; (2) makes blueprint dependency visible during review; (3) build agent **may** read the blueprint full text when it sees `based-on` / `extended` (plan may not read it; build may).

**Components (no anchor - worker chooses):** plan no longer pre-cites components with a `**Components:**` anchor. The full component library (`chunks/components/`) is forwarded to worker, and worker chooses by visual judgment. Plan only names desired structures by **role** in prose ("a framed stat block", "a pill row of labels"), not ids or HTML - same role/purpose approach as palette/type.

**Transition anchor (optional / soft - names "how this scene is entered"):**

> **This subsection + "Bridge anchor" below is the authoritative writing guide for transitions / bridges (single source of truth).** The later "Transition: translation" table only maps `intent -> registry type`; it does not restate machine rules. The validator hard-contract list above only says what is checked. Change rules here only.

- Shape: `**Transition:** <type> [DIRECTION] [<dur>s]`, e.g. `**Transition:** blur-crossfade` / `**Transition:** push-slide LEFT` / `**Transition:** zoom-through 0.3s`
- Optional types (Tier-B, transition happens **between scenes**, injected by harness onto clip wrappers after assembly; **you do not write GSAP**): `crossfade` / `blur-crossfade` / `push-slide` (with LEFT/RIGHT/UP/DOWN) / `zoom-through` / `squeeze`. Full vocabulary + selection guidance in `<SKILL_DIR>/../hyperframes-animation/transitions/TRANSITION-REGISTRY.md`
- **Use only 2-3 types across the film** (repetition = professional cohesion; see motion-language.md "transition vocabulary") - **this budget counts only Tier-B (inter-scene) choices among those 5; `shared-element` (morph) is worker-written bridge and does not count**, use it as the story needs. Scene 1's Transition is opening placeholder (no previous scene, ignored), and may be omitted
- **Omitting the whole line = accept default:** harness derives from surface conflict / energy (clashing backgrounds -> `blur-crossfade`, high energy -> `zoom-through`, calm -> `blur-crossfade`, otherwise `crossfade`). So for Tier-B, **omit when uncertain**; default is usually good
- **`shared-element` (Tier-A shared-element bridge) = translation of story-design `intent: morph`** - must pair with `**Continuity:** continue` (two scenes share worker) + `**Bridge:**` anchor (below). Tier-A bridge morph is written **inside the two scenes by the worker** (not harness injected); harness only applies seam-shell crossfade. **Tier-A is a premium opt-in**: `intent: morph` appears in `narrator_scripts` only when the user asked for premium/seamless transitions — on a standard run every boundary is Tier-B and this anchor never appears. You translate what story-design emitted; do not introduce `shared-element` on your own
- harness handles everything for Tier-B: overlap, outgoing clip extension, track assignment, GSAP stamping, verification. You only name intent; **never write transition code, touch timing, or touch index.html**

**Bridge anchor (only for Tier-A `shared-element`):**

- Shape: `**Bridge:** \`<bridge-id>\``, a single backtick-wrapped kebab-case logical name (e.g. `\`product-card\``/`\`avatar-circle\``)
- Comes from story-design `transition.sharedMotif` (narrative-layer "what element crosses scenes") - you turn that phrase into a stable machine name
- worker places an element with `data-bridge-id="<this name>"` in **both outgoing + incoming scenes** and designs the morph handoff between them. **You only name it; do not draw geometry** - concrete morph is worker work
- **The `**Bridge:**` anchor is written on the morph target scene** (the scene being entered by the morph; prep uses `toScene.transition`), and it has `Continuity: continue`; the morph source scene has `Continuity: break` (see cap=2 alignment below). Both workers' scenes include `data-bridge-id`, but only target scene writes `**Transition:** shared-element` + `**Bridge:**`. The pair must land in the same cap window = same worker, otherwise downstream prep fatal

**cap=2 grouping alignment (must be considered while writing the plan, or prep rejects and forces rerun):** when you write `shared-element`, you cannot see worker grouping yet - prep later computes grouping deterministically from `Continuity`: **`break` starts a new group, `continue` appends to the current group, and when a group reaches `cap` (default 2), a new group is forced**. A Tier-A pair must land in **the same group**, so a morph pair `(A -> B)` must be **exactly the first two scenes of a cap window**. Reliable pattern:

- **Set morph source A to `Continuity: break`** (A starts a new group), **set morph target B to `Continuity: continue`** (B appends, filling cap=2). This is the safest pattern.
- Counterexample (common fatal): A and B are both `continue`, but a prior `continue` scene already occupies slot 1 of the window -> A lands in slot 2 (group full), B is pushed to **next group** -> A/B split across workers -> prep fatal `Transition A→B: grouping splits the scenes across workers`.
- **Morph chains longer than 2 scenes** (3-scene demo sequence bridge chain) inevitably cross workers under cap=2 -> split into "one morph pair (Tier-A) + one Tier-B transition", or increase `--scenes-per-group`.

> One sentence: **morph pair = first two scenes of a cap window; safest is source `break`, target `continue`.** If you cannot reason it through, do not use Tier-A; use Tier-B (`blur-crossfade`) - the visual seam will still be clean.

> This is the plan agent's explicit commitment about how scenes connect. It must align with prose item 8 (transition to next scene). Item 8 is human-readable creative direction; `**Transition:**` / `**Bridge:**` anchors are machine instructions for harness/worker.

**SFX anchor (optional / soft - only write when using sound effects):**

Most scenes have no SFX - in that case **omit the entire `**SFX:**` line**. Omission = "no sound effect for this scene", validator does not complain. To add SFX, write `**SFX:**` alone on a line + one or more bullets:

```markdown
**SFX:**

- `impact-bass-1.mp3` at 0.2s, volume 0.35 — hero stamp lands
- `whoosh-short.mp3` at 4.1s — exit
```

(Explicit `**SFX:** none` is also accepted; but because it is optional, omitting the line when unused is simpler.)

**No silent drop risk:** once you cite a `<file>.mp3`, validator checks it immediately against `## SFX library` - misspelled filenames are Phase 3 fatal errors you can fix on the spot, no longer silently dropped by prep.mjs. So optional is safe: not writing = explicitly unused, writing = guaranteed valid.

- `<file>.mp3` must be listed in dispatch `## SFX library` (misspelling = validator fatal)
- `<T>s` is **scene-local seconds**; prep.mjs adds `start_s` offset automatically
- `volume` optional, default `0.35`; under narration use 0.2-0.3, pure SFX can be 0.4-0.6, 0.5+ may cover voice
- ` — <note>` is human annotation

**Placement rules:**

- **Impact / hit** (`impact-bass-*` / `ping` / `pop` / `glitch-*` / `whoosh`): trigger at the exact visual point, letting decay carry into the next shot (J-cut)
- **Riser / build-up** (`riser` 10s / `whoosh-cinematic` 5.5s): peak at the end; if it should explode at N seconds, trigger at `N - duration`
- **Short accent** (`click` / `click-soft` / `chime` / `sparkle` / `ping` / `whoosh-short`): sync with the visual point

**Less is more:** most scenes have zero SFX; one cue in a scene is typical. **Do not** add SFX at scene transitions (the hard cut itself is the audio-visual event).

**Forbidden:** estimated timestamps (`verify-output.mjs sfx` enforces ±0.1s drift) / shortening `data-duration` (impact cut mid-decay = amateur feel).

Available mp3 list is in dispatch `## SFX library` (each item has file / duration / purpose) - choose by purpose.

### Primary / Supporting Anti-Overlap Contract

Remember one rule: **only one primary subject at a time; all other visible content must be supporting.**

Risk scenes must include these two lines before prose:

```markdown
**PrimarySubjectTimeline:** 0-4.0s product panel primary; 4.0-7.0s proof cluster primary; 7.0-10.0s action headline primary, proof cluster supporting rail.
**Handoff:** Before the action headline enters, the proof cluster demotes to a small low-contrast rail. Camera push does not count as handoff. The new primary owns the center safe zone.
```

Rules:

- Multiple subjects can be on screen, but only one is primary; the rest must be supporting rail / side rail / background texture / low-emphasis chrome.
- Before a new primary enters, previous primary must exit / hide / compact / demote; **camera pan / zoom / push does not count as exit**.
- Action / payoff frame: primary headline / product / decision point owns the center safe zone; proof, labels, logos, stats, and card clusters, if retained, must be smaller, lower contrast, less animated, and outside primary bbox.

**Continuity comes directly from story-design** (no inference): each scene `transition.continuity` in `narrator_scripts.json` (`break` | `continue`) is already the narrative-layer judgment - **copy it into the `**Continuity:**` anchor**. `continuity` is already fixed by `intent` (`morph` => `continue`, others => `break`), so just copy it. **Any `continue` scene is necessarily `intent: morph`, and downstream requires it to name `shared-element`** (see §2 bidirectional hard contract). Scene 1 is always `break`. Cross-scene consistency is covered in §5 "variety" soft guidance.

**Transition: translating story-design narrative `intent` to concrete registry type** (this is visual-design's job - you have preset/palette/background/energy context; story-design does not). Each scene's `transition.intent` in `narrator_scripts.json` is one of 5 narrative intentions; translate it to a `**Transition:**` registry type using the table below (full vocabulary in `<SKILL_DIR>/../hyperframes-animation/transitions/TRANSITION-REGISTRY.md`):

| story-design `intent`              | -> `**Transition:**` registry type                              | Notes                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `morph` (+ `continuity: continue`) | `shared-element` (Tier-A)                                       | **must be `continue`**; also write `**Bridge:**` anchor (below). Worker writes shared-element morph in both scenes |
| `cut`                              | `crossfade`                                                     | clean cut; for high-energy moments you may omit Transition anchor and let default apply                            |
| `slide`                            | `push-slide <direction>`                                        | direction matches narrative flow (forward=LEFT/RIGHT, expanding downward=DOWN)                                     |
| `dissolve`                         | `blur-crossfade` when backgrounds clash / `crossfade` otherwise | inspect both scene `#root` backgrounds: large difference -> blur hides hard cut; similar -> normal crossfade       |
| `zoom`                             | `zoom-through`                                                  | camera push / high energy                                                                                          |

- **You have visual context, so you may override:** if a default translation is wrong for the preset (e.g. color clash should use blur where table says crossfade), use visual judgment - table is default, not law.
- **Use only 2-3 transition types repeatedly across the film** (repetition = cohesion, see motion-language.md) - **count only Tier-B inter-scene types; `shared-element` morph does not count**. `intent` narrows the choice; you choose concrete values within it.
- **When uncertain, omit the `**Transition:**` anchor** - downstream prep derives default from energy/color clash (see §2 Transition anchor). But for `intent: morph`, **you cannot omit** - must explicitly write `shared-element` + `**Bridge:**`.

**`**Bridge:**`anchor (only when`intent: morph`):** turn story-design `transition.sharedMotif` (narrative-layer "what element crosses scenes", e.g. "the product card") into a machine-readable bridge id:

```markdown
**Transition:** shared-element
**Bridge:** `product-card` <- logical name (kebab-case), downstream worker uses it as data-bridge-id
```

Machine rules (kebab-case, must pair with `Continuity: continue`, worker places `data-bridge-id` in both scenes, morph chain limited by cap=2) are detailed above in §2 Transition / Bridge anchor.

> If the effect you need is not in catalog: first try combining existing effects. Still insufficient -> **do not invent a name**; mark in phase report `needed effect missing: <description>`.

---

## 3. Design Principles (inlined in `## Design rules`)

Four rule files cover plan-layer design judgment - all organized by **role / intent / decision**, with no hex / px / ms / code. Already inlined in dispatch `## Design rules`; do not read from disk.

Four rule files:

- `rules/typography.md` - 7-level type role ladder / multi-dimensional hierarchy / font pairing / forbidden pairs / CJK
- `rules/color-system.md` - 7 palette roles / 60-30-10 / cross-scene consistency / dangerous combinations / background layering
- `rules/composition.md` - four canvas zones / 7 templates (film >=3 templates) / density rules / depth techniques
- `rules/motion-language.md` - 5 spring intents / duration tiers / beat structure / stillness-before-climax / continuous motion / transition vocabulary (film 2-3 types)

---

## 4. Writing Prose (after anchors)

**Step 0 (before writing, mandatory):** first restate this run's direction to yourself (Voice register / Blueprint decision for each scene) - full instructions live in the **agent prompt "Restate the contract before writing" section** (that persistent prompt is the single source of truth, not repeated here). Key constraint: restatement **only sets direction in your head; never write it into `section_plan.md`** (writing it = project-level preface = forbidden by §2 whole-file shape = validator fatal).

Then write one free-prose paragraph in the following 8-item order. This prose is passed **verbatim** to the downstream build agent - write as if briefing a senior animator who has not seen this brand.

1. **Emotion and rhythm footnote** - one sentence naming the beat's _feeling_ and _rhythm_ ("frustrated, slightly-off comma", "luminous launch-film slow build"). **This is the dividing line between real plan and generic AI output.**
2. **Spatial relationship** - composition template (centered / thirds / split / layered / asymmetric / triptych / strip), primary asset's canvas share (>=40%), and whitespace intent. **When top-level dispatch says `Captions: enabled` (planning hint derived by orchestrator from audio_meta; prep.mjs recomputes authoritative `group_spec.captions_enabled` in Step 5):** captions reserve the bottom ~17% band, so concepts that push content low (full-bleed cards, oversized hero, large CTA, stat stamp) must **explicitly tell worker to keep all content in the upper ~83% and reserve the bottom ~17% as caption territory**, with vertical center anchored around 0.42×height. Example wording: "centered in the upper ~83%, caption band reserved below", "bottom edge of card sits just above the caption band", "CTA vertically centered around 42% of canvas height." Background / ambient layers are unrestricted and remain full-bleed.
3. **Effect -> asset mapping** - for every id in `**Effects:**`, name the asset (`public/<basename>`, from this scene's `assetCandidates`) or text label driving it, and _when_ it fires in the scene phase timeline. **Default to using all scene `assetCandidates`** (story-design already spread them for coverage; do not prune again): primary subject still occupies >=40% canvas, choose the one most tied to the narrative, and have other candidates **coexist as supporting / ambient layers rather than being dropped** - triptych / strip / layered templates can stage multiple assets with hierarchy, or different phases can introduce them sequentially. If a candidate truly cannot fit this scene -> name it in item 7 negative sentence ("do not use `public/X` in this scene because..."), **do not silently ignore** (if it appears nowhere else, it is discarded). A candidate whose path ends in `.mp4` / `.webm` / `.mov` is a **moving clip** (worker renders it as a muted, looping `<video>`): say _when in the phase timeline it plays_ and whether it holds or loops, rather than treating it as a static image — a `.png` `[video-still]` is the static fallback. **Placement is fixed by the runtime, not the plan: a `<video>` must be a direct child of the host root (`index.html`), NEVER inside a scene's sub-comp `<template>` (it would render blank/black), and its per-scene motion must be authored on the MAIN timeline at global time — the scene sub-comp keeps only the frame/shell and cannot drive the host video.** Brief the effect/timing as usual; worker maps it to a host-root video per `hyperframes-core` → `variables-and-media.md` / `composition-patterns.md` archetype B.
4. **Brand style overlay (by role, not value)** - Palette: name 60% canvas / 30% surface (if preset has no surface token, use hairline + repeated canvas and say so) / 10% accent, and bind accent to a focal element; Type: what display is used for, what body is used for, whether mono eyebrow exists; Motion: reference only canonical role keys `EASE.entry` / `EASE.emphasis` / `EASE.exit` / `EASE.drift` and `DUR.snap` / `DUR.med` / `DUR.slow` (§1 item 4; these are role keys exposed by `easings.js`) - do not invent alias keys, because worker uses this key set directly and missing keys fall through. **Never copy hex / font names / ease curves / px / em / ms.** If `chunks/tokens.css` lacks a token (e.g. mono font not extracted), note expected fallback.
5. **Multi-phase choreography** - phase sequence `entry -> ambient drift -> major transition -> stillness -> emphasis -> exit` and rough duration ratio; explicitly name `stillness-before-climax`; name spring intent for each phase (`entry` / `gentle` / `snappy` / `heavy` / `slam`). If §3 selected a blueprint, follow the phase skeleton from that blueprint index description; this scene's emotional beat determines each phase's ratio and ease intent, **not the blueprint's exact timing values** (build work). Use **scene-local relative seconds / ratios** (e.g. "0-0.45s entry", "~0.5s setup hold"); **do not restate total scene duration / end timestamp in prose** (e.g. "exit until 2.82s") - total duration is in `**Duration:**`, and worker `data-duration` is pinned to `estimatedDuration_s`; prose approximations only conflict. Anchor order (PST/Handoff before prose) is in §2.
6. **Continuous / ambient motion** - what keeps the scene alive after entry: multiplicative breathing on hero (±2-5% scale), inverse-phase card sine drift (±6-8px), icon orbit, halftone density deformation, CTA glow pulse.
7. **One negative sentence** - what this scene must **not** do, in codex-plugin tone ("no halo behind the bell - Jake killed those", "no neon glow, this is a workspace").
8. **Transition to next scene** - detail depends on Tier: **Tier-A (`shared-element`/morph) exit is load-bearing** - worker writes the morph inside outgoing+incoming scenes, so specify which element crosses scenes and what pose it hands off (this is worker construction guidance). **Pure Tier-B (crossfade/blur-crossfade/push-slide/zoom-through/squeeze) exit is injected by Step 7 harness onto clip wrappers, and worker writes no exit tween** - a short sentence about eye destination is enough; **do not elaborate veil/dissolve/curtain mechanics** (nobody follows it, wasted tokens). Machine instruction always lives in `**Transition:**` / `**Bridge:**` anchors.

**Do not** write pixel values, GSAP timeline code, composition HTML, concrete hex / font names / ease curves - that is build-agent work. But give enough constraints that the result clearly belongs to _this scene_, not a generic interpretation: concrete intent roles, duration by ratio, font references by purpose, palette distribution by role, specific phase order.

**Do not restate global rules that workers already receive through dedicated channels** (saves tokens, avoids drift): each worker already receives `voice_file` (full DOM text recipe), `Captions` flag + its keep-out contract (bottom ~17% caption-band geometry), `tokens.css` / `easings.js` (all token values and curves). Therefore prose should **not repeat** mechanical voice recipe details (strip/case/line breaks), caption-band geometric constants, or any hex/font/curve values scene by scene - write only **scene-specific application or risk** (e.g. voice: "hero resolves as one-line UPPERCASE stacked words; `<mark>` binds 'videos'", not the whole recipe; caption: "CTA bottom edge stays just above caption band", not "bottom 17% is caption territory, anchor 0.42×height" every time). **Global rules without a dedicated channel still need to be carried scene by scene** (e.g. "no neon / no italic / 60-30-10 palette allocation / hard cut / stillness-before-climax beat") - worker only learns those from this scene's prose, so they are load-bearing, not repetition.

### Complete Scene Block Example (with anchors)

```markdown
## Scene 4: the-spiral

**Effects:** [`discrete-text-sequence`, `cursor-click-ripple`, `context-sensitive-cursor`, `sine-wave-loop`]
**Duration:** 6.20s
**Continuity:** continue
**Blueprint:** composed

Beat 2b — the spiral (frustrated, slightly-off comma). Centered chat-app composition: ...
```

```markdown
**Effects:** [`counting-dynamic-scale`, `center-outward-expansion`, `multi-phase-camera`, `svg-icon-enrichment`, `sine-wave-loop`]
**Blueprint:** extended `hook-counter-burst`
```

### Prose Example (read before writing)

> "Beat 2b — the spiral (frustrated, slightly-off comma). Centered chat-app composition: message stack scrolls up at accelerating pace, cursor sits anchored at the bottom-right, never moves. ~5-7 follow-up prompts flash through, each punctuated by a button click + a late SFX tick — pace tightens, tension builds. Hold on a final frustrated beat: cursor still, chat full, SFX _slightly_ off. **Palette: canvas + ink default + single accent on the cursor only — no halo, no glow.** Type: display in chat bubbles, body for supporting text. **Multi-phase: setup hold ~0.5s -> accelerating montage ~4.8s -> final still beat ~0.9s (stillness-before-climax) -> cut-the-curve LEFT into Act 3.** Hero cursor does multiplicative breathing on its glow only, not position. No neon."

**Order:** emotional tone -> composition -> palette by role -> type by purpose -> phase sequence with ratio durations + intent roles -> negative sentence -> transition. **No hex / font names / ease curves / GSAP code; every word does work.**

---

## 5. Soft Guidance (taste-level, affects plan quality but not validator)

### Scene Quality Floor - Three-Layer Motion Model

> This is the **quality-floor perspective** ("what counts as alive enough"); **how to write it per scene** is §4 item 6 (continuous/ambient motion). Same concept at two levels; the "multiplicative breathing is not yoyo" method is explained only here, so do not repeat the methodology in every scene prose.

Every scene must have:

1. **Macro Motion** - camera drift: slow whole-frame zoom + displacement (background and camera counter-scale is an archive signature; concrete values are build work)
2. **Element Motion** - content continues to drift / rotate / scale after entry (never static - use multiplicative breathing on final scale, not yoyo)
3. **Micro Motion** - ambient details: flowing gradient, breathing glow, loop particles, halftone density deformation

### Scene Quality Floor - Ambient Layer

Beyond core content, every scene needs:

1. **Background swell** - dual-radial overlay in brand-adjacent hues; or architectural grid for workspace scenes
2. **Ambient particles / scanline / halftone** - brand-color float particles, low-opacity scanline, or beat-deforming halftone field
3. **Emphasis moment** - at least one impact beat (ripple / glow burst / impact lines / screen-shatter)

### Multi-Phase Choreography

```
entry -> ambient drift -> major transition (morph / pivot / collapse) -> stillness-before-climax (~0.3-0.75s) -> result / emphasis -> idle breathing -> exit
```

An element that springs in and then sits still = slide, not video.

### Forbidden Patterns (most common failures)

- continuous motion covers <50% of scene duration
- treating 3px micro-float as the only "motion" (archive minimum amplitude ±6px or ±2-5% scale)
- using word-by-word text popping as the _primary_ visual (unless carefully choreographed as visual lead)
- all elements enter simultaneously (must stagger; total <=500ms)
- only ambient layer, no primary content (particles + captions)
- same composition every scene (at least 3 different templates per film)
- primary visual element <40% of canvas
- **when captions enabled, key content (CTA / hero / stat stamp / headline) enters bottom ~17% (y>900) caption band = covered by captions** (background/ambient layers may extend down; key foreground may not)
- generic AI clichés: saturated neon on pure `#000`, purple-blue AI gradient background, decorative floating bokeh balls
- solid background without swell / grid / scanline / particle
- jumping directly from action to payoff, with no `stillness-before-climax` comma
- multiple primary subjects fighting for center safe zone; any product / proof / logo / stat / headline / card cluster on screen together must have primary/supporting and handoff
- treating camera pan / zoom / push as old-content exit; camera moves the viewpoint but does not automatically reduce old primary visual weight
- **copying concrete hex / font names / ease curves from `chunks/tokens.css` / `chunks/easings.js` into prose** - that is build-agent work
- **forcing a mismatched blueprint** - blueprint is a tool, not an obligation; if `role` / `triggers` / emotional arc need "creative bending" to match, fall back to free composition from effects catalog
- **Reading blueprint full text** (`blueprints/<id>.md`) - contains GSAP code and DOM topology, build-agent territory; plan only uses `## Blueprints index`

### Variety

Across all scenes, use at least 3 different composition arrangements. The strongest archive plan (playground-launch) used 5+ visual universes across 8 beats, glued with one shared transition vocabulary (cut-the-curve) + one shared palette grammar. **Visual worlds varied, seam treatment consistent** - that is the principle.
