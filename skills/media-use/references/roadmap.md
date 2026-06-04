# roadmap & open items

## MVP

- **v0.0 — this skeleton:** `setup` · `organize` · `find` · `resolve` / `process` procedures, free-first wiring to `/hyperframes-media` local tools + `heygen voice` / `asset`. No new dependencies.
- **v0.1 — BGM / SFX resolve wedge.** **BGM unblocked** — `heygen` v0.1.0 ships an `audio` (BGM-catalog search) group (`heygen update` to get it; installed is v0.0.10). SFX still pending (no generation command). Image/icon `resolve` reuses Miao's **asset_scout** provider stack (PR #38601 — Google Images/SerpAPI + Noun Project, atomic/specific caching, vision self-review, rehost+dedup); see `resolve.md`.
- **UC1 validated 2026-06-04** — standalone `resolve(generate) → process(remove-bg) → organize` ran end-to-end with real local tools; see `personal-planning/media-use-design/uc1-test/`.

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
- Helper scripts (`register_asset`, `render_index`, `find_asset`) are the thin bookkeeping layer to add next; v0.0 describes the procedures.
- **Lineage:** `resolve` / search traces to the **RWA subagent** (`opus/rwa-subagent-standalone`, Wenbo) — origin of the two-pole query strategy, multi-source search (image / news / tweet / web), file-system-as-interface workspace, and the eval harness. `asset_scout` (PR #38601, Miao) is the productionized image slice. See `references/search-strategy.md`.
