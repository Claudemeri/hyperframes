---
name: media-use
description: >
  Root-level, on-demand media operations for any task (HyperFrames or not). Use when
  the user or another skill needs to find, obtain (search / generate), process
  (background removal, upscale, trim, transcribe), organize, reuse, or prepare an
  image / audio / video / BGM / SFX / voice asset. Turns a media need into a stable
  workspace asset plus a readable asset index. Do NOT use for video story planning,
  workflow routing, full-video review, or timeline editing — those belong to
  /video-workflows and the workflows it routes to.
metadata:
  tags: media, assets, workspace, manifest, resolve, organize, reuse, bgm, sfx, tts, background-removal
---

# media-use

Agent Media OS. Turns an **explicit media need** into a stable workspace asset, a readable asset index, the necessary processing / generation calls, and (optionally) a declarative HyperFrames snippet. It does not own narrative, scene design, review, or composition layout.

media-use is a thin **orchestration + ledger** layer. It does not re-implement capabilities — it **routes** to existing tools:

- `/hyperframes-media` — local / free CLI tools: `npx hyperframes tts | transcribe | remove-background`, captions.
- `heygen` CLI — account-backed: `heygen voice speech create` (TTS), `heygen asset create` (upload); BGM / SFX when they ship.
- `/hyperframes-core` — placing a resolved asset into a composition (placement is not media-use's job).

> Status: **v0.0 draft skeleton** (branch `feat/media-use-skill`). Scoped to the MVP agreed in the 2026-06-04 review — see `references/roadmap.md`.

## When to use — and when to stay silent

Use on an **explicit media need**: locate / obtain / transform / reuse / prepare a specific asset ("find a CTA click sound", "remove this image's background", "add background music", "reuse the previous logo").

**Stay silent otherwise.** Root-level reach means this skill can trigger anywhere — default conservative, on-demand only. Better to miss than to nag. Never run a media operation the user did not ask for. (Triggering discipline is a required eval — see `references/roadmap.md`.)

## The six verbs

Each verb is a **skill procedure** executed over the real underlying commands — not (yet) a shipped `hyperframes media <verb>` CLI command. Whether to promote them to CLI subcommands is an open item with James (see `references/provider-routing.md`).

| Verb           | What it does                                                         | Reference                                                 |
| -------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| setup          | lazy-init the media workspace; read provider / auth status           | `references/setup.md`                                     |
| organize       | register assets → AssetRecords → manifest → regenerate index         | `references/workspace.md`                                 |
| find / preview | read the workspace ("grep for media"); v0.1 = find                   | `references/find.md`                                      |
| resolve        | one procedure over search / generate / fetch                         | `references/resolve.md` · `references/search-strategy.md` |
| process        | transform an asset (remove-bg, upscale, trim, transcribe, normalize) | `references/process.md`                                   |
| prepare ◇      | (open) emit a declarative HyperFrames snippet for an asset           | `references/prepare.md`                                   |

**Runnable layer (v0.1):** `scripts/{init-workspace,register-asset,render-index,find-asset}.mjs` — zero-dependency node helpers that make setup / organize / find **executable and reproducible** (manifest = SSOT, index regenerated). Capability calls (`hyperframes remove-background`, image gen, `heygen audio`) run as documented, then pipe their output path into `register-asset.mjs`.

## Workspace contract

- `<workspace>/assets/manifest.jsonl` is the **source of truth** — one AssetRecord per line; only the skill's helpers / the CLI write it.
- `<workspace>/assets/index.md` is a **generated, agent-readable view** — read it, never hand-edit it.
- Central object = **AssetRecord** (`references/asset-record.md`). media-use is root-level and often runs with no composition, so the unit is an asset, not a video binding.
- Compositions reference **project-local paths / asset ids**, never prompts or remote URLs — keeps the HyperFrames render deterministic.
- **Lazy:** if no workspace exists on first use, create one (`references/setup.md`).

## Provider routing (free-first)

Routing (local / HeyGen / ElevenLabs) is decided by the **CLI from environment**, never by this prompt. See `references/provider-routing.md`.

- **Default = free / local first** (Bin, 2026-06-04): lead with `npx hyperframes` tools + royalty-free fallbacks so users get value before any paywall.
- `HEYGEN_API_KEY` / OAuth → `heygen` CLI · `ELEVENLABS_API_KEY` → ElevenLabs · neither → free / local.

## Relationship to other skills

- `/video-workflows` and its workflows **call media-use on demand** — after extraction, when an asset is missing, when review finds an asset inadequate, on edit. media-use never routes workflows or reviews the whole video. (Redundant asset preferences in a workflow are fine — Bin: "I don't mind redundancy.")
- `/hyperframes-media` owns the **local tool docs** (tts / transcribe / remove-background / captions). media-use **invokes** those commands and records the outputs; it does not duplicate their reference material.
- `/hyperframes-core` owns **placement** of a resolved asset into a composition.

## Hard rules

- No video story planning, workflow routing, full-video review, or timeline editing.
- After creating or processing an asset, **always** append to `manifest.jsonl` and regenerate `index.md`.
- Never write an unresolved prompt or a remote URL into a composition — only a frozen, project-local asset reference.
- Gate paid capability behind a key at the **resolve / process** step — never at planning / organize / find.
- Never put cost / model-selection logic in this prompt; the CLI decides from env.
