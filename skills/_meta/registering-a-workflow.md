# Registering a new video workflow

How to wire a new top-level **workflow** skill (a "make X → video" pipeline like `/pr-to-video`) into HyperFrames so the router and every agent can find it. Read this before adding, renaming, or removing a workflow.

> This is about **registration / routing**, not about authoring animation skills (rules / blueprints / examples) — that lives in [`hyperframes-skill-authoring/`](hyperframes-skill-authoring/SKILL.md).

## How routing actually works (two layers)

1. **Skill selection (model layer).** The agent matches the user's request against each skill's `description:` frontmatter and picks one. **This `description` field IS the routing signal** — a skill that exists on disk but whose description doesn't claim the intent will never be selected. Write the description to _win_ its own intent and _defer_ every neighbouring intent (`NOT for … → /other-skill`).
2. **Routing content (doc layer).** [`hyperframes-read-first`](../hyperframes-read-first/SKILL.md) (the router) + the root `CLAUDE.md`/`AGENTS.md` are prose that tell an already-oriented agent which workflow to enter. The router is the **single source of truth**; `CLAUDE.md` and the CLI templates only carry a compact pointer + one bullet per workflow (do **not** re-create a full skill table there — that duplication goes stale).

A workflow is "registered" only when **both** layers know about it.

## First decide: workflow, or domain skill?

- **Workflow** — takes an input (URL, PR, text, footage…) and produces a finished video. It is **routable**: it belongs in the router's decision table + gets a `### /name` description block. (PLV, faceless-explainer, pr-to-video, website-to-hyperframes, embedded-captions, general-video.)
- **Domain / capability skill** — a technical reference a workflow loads while building (`hyperframes-core`, `-animation`, `-creative`, `-cli`, `-media`, `-registry`). It goes in the router's **capability map only**, never the decision table.

The rest of this doc is for **workflows**.

## Registration checklist

Touch every one of these (paths relative to repo root):

1. **`skills/<name>/SKILL.md`** — create it. Frontmatter needs `name:` (matches the dir) and `description:`. Description recipe: `<input> → <intermediate artifacts> → <output video>`, then **Triggers** (phrases that should route here), then **NOT for** (each neighbouring intent → the skill that owns it). Keep concrete values out of the description; it is matched as prose.
2. **`skills/hyperframes-read-first/SKILL.md`** (the router) — four spots:
   - the frontmatter `description:` capability list (the running "…, X, Y, Z…" sentence),
   - the **decision table** — put the skill in the right INPUT column / length row,
   - the **routing procedure** (step 2 input-type pick, step 3 disambiguation) — add the rule that sends the intent here,
   - a **`### /<name>` block** under "Workflow descriptions" with **Input / Output / Triggers / Do NOT use for**.
3. **`CLAUDE.md`** + **`AGENTS.md`** (repo root) — add one workflow bullet to the list. Don't add a table row; the bullet + the read-first pointer is the current convention.
4. **`packages/cli/src/templates/_shared/CLAUDE.md`** + **`_shared/AGENTS.md`** — add the same bullet, so projects created by `hyperframes init` ship with it. (These two files are kept byte-identical to each other.)
5. **Sibling workflows' "Do NOT use for / NOT for" lists** — add mutual cross-refs. Every neighbour that could be confused with the new workflow must defer to it (`→ /<name>`), and the new workflow must defer back. Usually PLV / faceless / pr-to-video / general-video + the router's matching blocks.
6. **`CREDITS.md`** — only if the workflow derives from third-party code/assets (add a Third-party licenses entry).
7. **`scripts/test-skills-fresh.sh`** — add the name to the `WORKFLOWS=( … )` array and an example line under "next steps" (the sandbox test harness).

## Resolve routing conflicts (critical)

If the new workflow overlaps an existing one (e.g. two skills both claim "URL → video"), do **not** ship both with greedy descriptions — they fight at the model-selection layer and routing becomes non-deterministic. You must:

- pick the **boundary** (which intent each owns), then encode it in **both** `description`s and the router's step-3 disambiguation, and
- **narrow the greedier description** so it stops claiming the other's intent, and
- add an **"ambiguous → ask one question"** rule when the boundary is genuinely fuzzy.

Example boundary in the tree today: a website URL splits by _intent_ — marketing/launching a product → `/product-launch-video`; a general site → video → `/website-to-hyperframes`.

## Gate (run before declaring done)

```bash
npm run lint:skills          # the gate — must be green
git add skills/<name>        # if the dir is still untracked
grep -rn "<name>" --include="*.md" --include="*.sh" . | grep -v node_modules | grep -v skills_pre
```

The last grep is the **completeness check** — after registering (or de-registering) confirm the name appears in exactly the touch-points above and nowhere stale.

## De-registering / removing a workflow

Reverse the checklist: delete `skills/<name>/`, then scrub the name from every touch-point (router table + procedure + block + cross-refs, root `CLAUDE.md`/`AGENTS.md`, both CLI templates, `CREDITS.md`, the test script). Re-run the grep above; the only remaining mentions should be intentional "this workflow was removed" notes. Skills are git-tracked, so a deletion is recoverable.

## Worked reference

The 2026-06-08 change on `test/skills-fresh` did all of this in one pass: **removed** the `footage-recut` stub and **registered** `website-to-hyperframes` + `embedded-captions` across every file listed above. Use that commit/diff as a concrete template.
