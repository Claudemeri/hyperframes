# search strategy — RWA (Real-World Assets)

The canonical design for media-use's `resolve` search is the **RWA subagent** (`opus/rwa-subagent-standalone`, Wenbo's): _given text for a video, understand it, plan queries, search, review, collect._ Miao's `asset_scout` (experiment-framework PR #38601) is the **productionized image/icon slice** of this design. This file keeps the full origin so `resolve` doesn't regress to "just search."

## resolve is four steps, not one

1. **Analyze / plan** (LLM) — read the input; extract named entities (people, orgs, brands, locations, events), key topics that need visuals, and temporal context. Emit a search plan.
2. **Search** (no LLM) — execute the plan across sources; high-priority queries first, independent ones in parallel. The file system is the interface (results land in the workspace).
3. **Review / select** — judge each candidate, mark `use` / `maybe` / `reject`. **This is the step that makes resolve good** (Bin: search ≠ resolve; agents that take the first/generated result produce bad output).
4. **Organize** — write the kept assets to the workspace ledger (`workspace.md`); freeze stable paths (rehost if third-party).

## Two-pole query strategy (the core rule)

Generate ONLY **atomic** or **specific** queries — never middle-ground.

- **Atomic (1–3 words)** → composable visual building blocks: portraits ("Elon Musk"), logos/icons ("SNL logo"), objects ("microphone"). Platform: almost always `image`. (These are the `atomic` queries `asset_scout` caches — stable, high reuse.)
- **Specific (5–15 words)** → editorial / contextual: news events, tweets, articles. Platform: `news` / `tweet` / `web`. Near-unique per video → not cached. If it returns nothing useful, **give up — do not broaden and retry.**
- ❌ Never the middle ("Elon Musk SNL" — too vague for news, too specific for an atomic image).

## Platform routing

| Content              | Platform | Strategy |
| -------------------- | -------- | -------- |
| person portrait      | image    | atomic   |
| logo / icon / symbol | image    | atomic   |
| object / scene       | image    | atomic   |
| news event           | news     | specific |
| social reaction      | tweet    | specific |
| background / context | web      | specific |

## Review: text vs vision ◇ (decision)

- **RWA origin:** text-only review (title / snippet / description) — fast, cheap, no image analysis.
- **asset_scout (later):** added a **vision** self-review to pick the best candidate — higher quality, more cost.
- Decide per use: text-only for v0 speed; vision when selection quality matters. This is the "selection is the hard part" crux.

## Principles (from the origin)

- **No video search** — low ROI, skip.
- **No reframe** — modern generation handles aspect ratios.
- **Fail fast** — a failed specific query is skipped, not broadened.
- **File system is the interface** — all I/O through the workspace.

## Providers

- **image / icon:** `asset_scout`'s stock-provider layer (Google Images / SerpAPI + Noun Project) is the production path — reuse it. (The origin called Google Custom Search directly; production wraps it in the stock-provider layer.)
- **news / tweet / web:** the RWA subagent's `search_news` / `search_tweets` / `search_web` scripts — not yet in media-use; a later source-adapter (`/hyperframes-media`-style).

## Eval — already exists (Wenbo's)

The RWA subagent ships a benchmark (`run_benchmark.py`, 10 test cases incl. `tc01_elon_musk_snl`) + a model-comparison eval (`run_model_eval.py`). **Reuse this as the base for the resolve-quality + triggering eval Bin required** — it's already yours; extend it with triggering cases.
