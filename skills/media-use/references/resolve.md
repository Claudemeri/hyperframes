# resolve

One procedure over reuse / search / fetch, so the agent does not micro-manage providers. resolve is the trickiest verb — get the **selection** right, not just the call (Bin, 2026-06-04: agents that just `generate` everything produce bad output).

## Decision order

1. **project assets** — already have a usable one? → use it
2. **personal reusable scope** (`$MEDIA_USE_HOME`, default `~/.media-use`) — same canonical **entity** already owned? → reuse it (copy a project-local consumed copy; bump `used_in`). Exact entity match is mechanical; fuzzy ("Elon Musk" vs "Elon Musk, Tesla CEO") is a model judgment.
3. **provider search** — backend returns ranked candidates (never auto-taken)
4. **SELECT** — the **model** picks from the candidates: look (numbered montage) or read (stored text captions). Never blind top-1; `--auto` ordered fallback is for headless runs only.
5. **freeze** — download the pick to a stable local file; the remote URL is never what a composition references
6. **register** the AssetRecord (`asset-record.md`): `entity` (the reuse key), the caption as `description`, provenance incl. `source_url` and the selection reason
7. (embedded) inject into the host's own format — e.g. faceless `assetCandidates` (this is the embedded answer to `prepare.md`)

> **Visual generation is deliberately OUT of resolve** (2026-06-08): search = real assets only — the wedge is exactly the things a model cannot invent (real people, brand logos, product shots, real places). Invention belongs to the host workflow. (TTS is the one generative type resolve keeps: voice, local Kokoro.)

## Selection — a model decision through affordances

- **Caption-once:** every searched image is vision-captioned to text **once**, cached per URL (`$MEDIA_USE_HOME/.captions.json`) and stored in the manifest `description`. All later reranking / reuse reasoning compares only the stored text — the same image is never re-visioned (warm runs ~4x faster).
- **Two affordances:** `select-sheet.mjs` (numbered montage, the agent looks) · `select-rerank.mjs --describe-only` (candidates + captions + montage, **no pick made** — agent-first) · `select-rerank.mjs` without the flag = headless text-rerank pick (fallback).
- Prefer: on-intent subject, clean/usable (a real logo over an article thumbnail; a clear portrait over a busy collage), good resolution, **background that fits the host style** (a white-on-black logo on a light paper style reads as a dark box — prefer transparent or plan a remove-bg).

## Runnable

`node scripts/resolve.mjs --workspace <dir> --type <bgm|tts|image|icon> …`:

- **image / icon** — `--intent "<query>"` searches via `MEDIA_USE_SEARCH_CMD` and prints ranked candidates **without registering**. Then `--pick <index>` / `--auto` (ordered top-5 download fallback, browser UA), or — agent-first — `--url <picked-url> --entity "<Canonical Name>" [--desc "<caption>"]` freezes exactly the agent's pick (registered `reusable: true`, entity-tagged).
- **bgm** — `--intent "<text>"` runs `heygen audio sounds list`, prints candidates; `--pick <id>` / `--auto` downloads + freezes into `assets/audio/bgm/`.
- **tts** — `--text "<text>" [--voice af_heart]` runs `hyperframes tts` (Kokoro, free) into `assets/audio/voice/`.
- **scene-based hosts** — use the bridge `resolve-scenes.mjs` (`--plan` / `--search-needs` / `--apply-decisions` / `--auto`); contract in `SKILL.md`.

## Search backend

`MEDIA_USE_SEARCH_CMD` = an executable taking `--query --media image|icon --num N`, printing one JSON line of candidates. Current dev backend: the asset_scout CLI (EF repo, infisical) — **eval-only; open-web image licensing is unresolved**. Shipped path: `heygen` CLI search over HeyGen-licensed assets (James's Pinecone; pending). A real brand logo is `media:"image"` (Google Images), never `"icon"` (Noun Project has no brand marks).

- **SFX — still pending.** No SFX endpoint; with key → `needs_endpoint` + royalty-free fallback; without → royalty-free base library.

## Search design — RWA origin + asset_scout (image slice)

resolve's search is not one step — it's **analyze → search → review → organize**, with the two-pole query strategy (atomic vs specific) and multiple sources (image / news / tweet / web). The canonical design is the **RWA subagent** (`opus/rwa-subagent-standalone`, Wenbo's). **Full design: `search-strategy.md`.**

Miao's **`asset_scout`** (experiment-framework PR #38601) is the **productionized image/icon slice**: Google Images/SerpAPI + Noun Project providers, atomic-query caching, `filter_valid_image_urls` gate, vision self-review, rehost + dedup. Its `AssetNeedPlan` / `AssetCandidate` map onto media-use's resolve input + `AssetRecord`.

**Reuse both — don't build a parallel search.** Long-term, expose the provider stack through the CLI so every surface shares it.
