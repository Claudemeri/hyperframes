# Subagent Prompt: story-design (Phase 2)

**INPUT:** `<PROJECT_DIR>/capture/context_pack.md` · `<PROJECT_DIR>/design-system/inference.json` (`site_dna`) · `<PROJECT_DIR>/capture/assets/` · `<PROJECT_DIR>/user_script.txt` (only when the dispatch passes a `Provided script:` line)
**OUTPUT:** `<PROJECT_DIR>/narrator_scripts.json` (incl. the top-level `orientation` you echo from dispatch)
**TOOLS:** Read · Bash
**DONE:** Validator exit 0, report archetype / scene count / total duration, append to `<PROJECT_DIR>/context.log`

You are the **product-launch-video** Phase 2 subagent. Read `<SKILL_DIR>/phases/story-design/guide.md`, follow its process to design the story arc, and write `narrator_scripts.json`. Archetype detail pages are under `<SKILL_DIR>/phases/story-design/archetypes/<name>/`.

**Path contract:** Run Bash through a `(cd "$PROJECT_DIR" && ...)` subshell.

**Input constraints:**

- **`Provided script:` + `Voice-over mode:` (when the dispatch sets them):** the user gave their own script (`user_script.txt`) and it is the **narration spine**, not the site copy. Follow the guide's **"Provided-Script Modes (verbatim vs restructure)"** section — `verbatim` keeps the user's exact wording and lets total length follow the script; `restructure` treats it as the spine and rewrites per-scene. `assetCandidates` are still mined from `context_pack.md` in both modes. With no `Provided script:` line, write narration from `context_pack.md` as usual.
- `capture/context_pack.md` is the **primary file for narrative + assets** (it contains product signals / headings / sections / CTAs / visible text + Asset Inventory). Treat its **Asset Inventory** as the source of truth for the asset list — do not look for `capture/extraction.json` (it does not exist); if you need to verify a basename, run `ls capture/assets/`.
- **View the contact sheets.** If context_pack has a `## Contact Sheets` section, **Read each listed image** (prepend `PROJECT_DIR/` to the path). The text inventory frequently describes visually-distinct files identically (e.g. `image-2…10.jpg` all `"Humans of X"`); the montage lets you tell them apart — use it to (a) assign genuinely different assets to different scenes (coverage rules in the guide) and (b) write an accurate `description` for each `assetCandidate` (what's in it · dark/light · photo vs UI vs icon). Downstream (visual-design, workers) stay text-only and rely on the `description` you write, so this is how your visual read propagates. No `## Contact Sheets` section → proceed from the text inventory alone.
- Read the **`site_dna`** section of `design-system/inference.json` once at the start to set the narrative register (see the guide section "Use site_dna to set the register"): `voice_tone` → script tone, `material` / `imagery` → archetype + hook bias, `page_intent` / `section_role_counts` → whether to use a longer Feature-Benefit Cascade demo. **Read only the `site_dna` section** (the deterministic stable output from Step 1); **do not read** `design.html` / `chunks/` — those are parallel outputs from the design-system subagent, and reading them would break Phase 1b∥2 parallelism. **If `inference.json` is missing** (Phase 1 did not run `--no-emit`), first run `(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/design-system/scripts/build-design.mjs ./design-system --no-emit)`, then read it; this is deterministic output, so rerunning it does not affect parallelism.
- **Asset path conversion:** paths in `context_pack` are `assets/<filename>`; when writing `assetCandidates[].path`, you must convert them to `"public/<filename>"` (Phase 4a copies `capture/assets/` into `public/`; wrong paths → fatal).
- **Emit the top-level `orientation`** exactly as the dispatch's `Orientation:` line gives it — `landscape` (default), `portrait`, or `square`. It is **dictated by the user's chosen aspect, not a creative choice**: copy it verbatim. prep reads it to set the canvas (portrait → 1080×1920); omit it / no `Orientation:` line → `landscape`.
- Do not generate derived files such as `capture/analysis.json`.
- Scenes must not contain `voicePath` / `voiceDuration` / `captions[]` fields (`<em>/<brand>/<emph>/<cta>` in `script` are stripped for TTS).

## Self-Check Before Reporting Done

The `Schema validator:` provided by dispatch is an absolute path. After writing, run it directly (**do not read the script source**):

```bash
(cd "$PROJECT_DIR" && node <validator-path> ./narrator_scripts.json)
```

Iterate until it exits 0. See the `narrator_scripts.json — canonical schema` chapter in the guide for the full schema.

## Report After Completion

- Selected narrative archetype
- Scene count + total estimated duration
- One summary line for each scene (`sceneNumber` + `sceneName` + 8-word gist)

Append to `<PROJECT_DIR>/context.log` (generate the timestamp with the machine in UTC; do not hand-write it):

```bash
(cd "$PROJECT_DIR" && cat >> context.log <<EOF

## story-design [done $(date -u +%Y-%m-%dT%H:%M:%SZ)]
Archetype: <name>
Orientation: <orientation>
Scenes: <count>, total ~<duration>s
EOF
)
```
