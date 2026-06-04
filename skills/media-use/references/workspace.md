# workspace

Files, not a DB. Two tiers: a per-project workspace + a global reusable index.

## Layout

```
workspace/assets/
  global_manifest.jsonl    # cross-project reusable index
  global_index.md
  cache/reusable/
project/assets/
  manifest.jsonl           # SSOT for this project (one AssetRecord per line)
  index.md                 # generated, agent-readable view
  raw/ generated/ processed/
  audio/{bgm,sfx}/  preview/
project/.media-use/
  config.json  reports/  snippets/
```

## Source of truth

- `manifest.jsonl` = SSOT for the project. Only the skill's helpers / the CLI write it.
- `index.md` = generated, human/agent-readable view. **Read it; never hand-edit it.** Regenerate from the manifest after any change.
- `global_manifest.jsonl` = cross-project reusable index (post-project organize promotes assets here).

## organize (procedure)

Bring files (uploaded / searched / generated / processed) under management:

1. copy or move into the right `assets/` subdir
2. create an AssetRecord (`asset-record.md`) — description, tags, source, usage_intent
3. append the record to `manifest.jsonl`
4. regenerate `index.md`

Runnable: `node scripts/register-asset.mjs --workspace <dir> --id … --type … --path … --source … [--derived_from … --usage_intent … --tags a,b]` (or `--json '{…}'`) does steps 3–4 — upsert by `asset_id` + reindex. `render-index.mjs` regenerates the view alone.

## Reuse — post-project + cross-project

- **On session end / project done:** mark which assets the composition used (`used_in`, `usage_count`, `reusable`); promote reusable ones to `global_manifest.jsonl`; regenerate `global_index.md`. (Can be a cron / post-session hook.)
- **On a new similar project:** query `global_index.md`, copy selected assets into the new project's `assets/`, register them locally.

> Compositions reference the **project-local copy**, never the global path — this keeps the render reproducible and prevents a cleaned global cache from breaking an old project.
