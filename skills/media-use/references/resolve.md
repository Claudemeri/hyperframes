# resolve

One procedure over search / generate / fetch, so the agent does not micro-manage providers. resolve is the trickiest verb — get the **selection** right, not just the call (Bin, 2026-06-04: agents that just `generate` everything produce bad output).

## Decision order

1. **project assets** — already have a usable one? → use it
2. **global reusable index** — exists there? → import a project-local copy
3. **provider search** — inventory hit? → fetch
4. **generate** — none found and generation is warranted? → generate
5. **fallback** — no auth / no provider? → free / local or royalty-free base
6. **register** the AssetRecord (`asset-record.md`)
7. (optional) emit a usage hint / snippet — see `prepare.md`

> Do **not** default to step 4. Search / reuse first; generation is the easy escape hatch and the output is usually the weakest.

## Free-first routing (today)

- **TTS / voice:** `npx hyperframes tts ...` (Kokoro, local) by default; or `heygen voice speech create` (needs key; `voice_id` must support the `starfish` engine).
- **transcription:** `npx hyperframes transcribe --model <m> ...` (Whisper, local). Always pass `--model` (see `/hyperframes-media`).
- **images / icons:** no `heygen` image command — search via the **asset_scout** provider stack (see "Image / icon search" below). video / upscale: route via CLI when available, else ask the user or use what they provided.

## BGM / SFX — v0.1 wedge

Procedure shape:

```
resolve --type bgm --intent "subtle confident tech product launch background"
resolve --type sfx --intent "premium CTA click"
```

- **BGM — available.** `heygen` CLI **v0.1.0** adds an `audio` group: "search the background-music catalog." (The installed binary here is v0.0.10 — run `heygen update` first.) Wire resolve's search step to `heygen audio ...` for BGM.
- **SFX — still pending.** No SFX command in v0.1.0 (the `audio` group is BGM _search_ only, no generation). Until an SFX path exists: with key → `needs_endpoint` + royalty-free fallback; without key → royalty-free base library.

## Search design — RWA origin + asset_scout (image slice)

resolve's search is not one step — it's **analyze → search → review → organize**, with the two-pole query strategy (atomic vs specific) and multiple sources (image / news / tweet / web). The canonical design is the **RWA subagent** (`opus/rwa-subagent-standalone`, Wenbo's). **Full design: `search-strategy.md`.**

Miao's **`asset_scout`** (experiment-framework PR #38601) is the **productionized image/icon slice**: Google Images/SerpAPI + Noun Project providers, atomic-query caching, `filter_valid_image_urls` gate, a **vision** self-review (origin used text-only — a decision, see `search-strategy.md`), and rehost + dedup. Its `AssetNeedPlan` / `AssetCandidate` map onto media-use's resolve input + `AssetRecord`.

**Reuse both — don't build a parallel search.** Long-term, expose the provider stack through the CLI so every surface shares it. (`heygen` itself has no image command.)
