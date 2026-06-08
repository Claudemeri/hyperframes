# roadmap & open items

## MVP

- **v0.0 — this skeleton:** `setup` · `organize` · `find` · `resolve` / `process` procedures, free-first wiring to `/hyperframes-media` local tools + `heygen voice` / `asset`. No new dependencies.
- **v0.1 — audio + processing wedge (built + verified 2026-06-05).** Per James's review the wedge is **BGM + TTS + transcribe**, not just BGM/SFX — _"TTS and ASR as well, basically what we already have in hyperframes CLI."_ All four run through `resolve.mjs` / `process.mjs`:
  - **BGM** — `heygen audio sounds list` (v0.1.0): search hands candidates back, `--pick`/`--auto` downloads + freezes the signed URL.
  - **TTS** — `hyperframes tts` (Kokoro, free/local).
  - **remove-bg** + **transcribe** — `hyperframes remove-background` / `transcribe` (free/local; `transcribe --json` is a status summary — the script moves the real transcript to a stable per-asset path).
  - **SFX** still pending (no heygen endpoint; `type=sound_effect` reserved). **Image/icon** search reuses Miao's **asset_scout** stack (PR #38601 — Google Images/SerpAPI + Noun Project, atomic/specific caching, vision self-review, rehost+dedup) — not yet wired; see `resolve.md` / `search-strategy.md`.
- **UC1 validated 2026-06-04** — standalone `resolve(generate) → process(remove-bg) → organize` ran end-to-end with real local tools; see `personal-planning/media-use-design/uc1-test/`.
- **Scripts verified 2026-06-05** — `resolve` (bgm search/pick/auto + tts) and `process` (remove-bg + transcribe) ran end-to-end on a fresh workspace; 5 assets registered with correct `provenance.derived_from` lineage.

## Required alongside v0.1

- **Evals — especially triggering evals:** when does this root-level skill fire vs stay silent? (Bin, 2026-06-04 — required for the new flat skill structure.) **Base it on the existing RWA benchmark** (`opus/rwa-subagent-standalone`: `run_benchmark.py` + 10 test cases + `run_model_eval.py`) — Wenbo's, already built; extend with triggering cases.

## Open (◇) — decide with Bin / James

- `prepare` in scope, or does the workflow own snippet-writing? (the main open design question — `prepare.md`)
- standalone `preview` / contact sheet — v0.2?
- a **Studio UI** for browsing global reusable assets (James, 2026-06-04)
- **per-skill memory** of user provider preferences in the global workspace (James, 2026-06-04)
- promote media-use verbs to real `hyperframes media <verb>` CLI subcommands, or keep as skill procedures + helper scripts? (James)

## Decided in the 2026-06-04 review

- root-level & standalone; **on-demand**; `manifest` = SSOT / `index` = view; CLI owns model/provider routing; **free-first**.
- CLI binary = **`heygen`** for capability APIs (not a HyperFrames media CLI), except cloud-rendering which stays in the HyperFrames CLI.
- redundancy with `/video-workflows` asset preferences is acceptable ("I don't mind redundancy").

## Build notes

- Branch: `feat/media-use-skill` (off local `main`, which is ~412 commits behind `origin/main` — rebase onto `origin/main` before opening a PR).
- Follows the `hyperframes-media` skill convention (`SKILL.md` + `references/`), not the animation three-tier (rules/blueprints/examples) structure.
- Helper scripts built: `init-workspace`, `register-asset`, `render-index`, `find-asset` (bookkeeping) + `resolve`, `process` (capability wrappers, zero-dep node, shell out to `heygen` / `hyperframes`). `make_snippet` (blocked on `prepare` ◇) and `validate_manifest` are the remaining GPT-listed helpers, not yet built.
- **Lineage:** `resolve` / search traces to the **RWA subagent** (`opus/rwa-subagent-standalone`, Wenbo) — origin of the two-pole query strategy, multi-source search (image / news / tweet / web), file-system-as-interface workspace, and the eval harness. `asset_scout` (PR #38601, Miao) is the productionized image slice. See `references/search-strategy.md`.
