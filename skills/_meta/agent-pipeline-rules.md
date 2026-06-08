# Agent Pipeline Rules

Five rules every CLI-driven authoring, repair, or finalize agent in these skills follows. Read once per dispatch before acting on any CLI output.

## 1. Validate keys / external CLIs in the first 60s, not at use site

Before any long-running phase (TTS, BGM, fan-out, render), prove every external dependency is reachable: required env keys are non-empty AND minimally callable; required CLIs (`gh`, `ffmpeg`, `python3`, `npx hyperframes`) respond. A missing key discovered after 4 worker agents wastes the workers.

If a dependency is missing, STOP the pipeline and report. Do **not** launch detached / background processes whose failure surfaces only when a later phase reads their output — failure must surface within seconds of the cause, not minutes later when the orchestrator polls for the artifact.

## 2. Read the offender — never the `Fix:` line

CLI tools (`lint`, `validate`, `inspect`, perception) print a `Fix:` suggestion derived from the symptom. The suggestion is a hint, never a diagnosis. Before editing anything in response to a finding, write down three things explicitly:

- **Offender** — the selector / element / `file:line` cited
- **Container** — the parent the offender is measured against
- **Measurement** — which numeric / geometric field failed (layout box, contrast ratio, duration, etc.)

Decide the fix from those three. If the `Fix:` line contradicts what the three say, ignore the `Fix:` line.

## 3. Retry budget: 3 strikes on the same error → STOP

Any edit → re-verify → edit loop has a hard cap of **3 attempts per identical error**. Identity = the `(offender, container, measurement)` tuple from rule 2.

Before each retry, confirm the tuple has changed from the previous round. If it has not, STOP and report the current state — do not keep editing in the hope the loop converges. Surfacing a stuck state is cheaper than burning a tool budget on a misdiagnosis.

## 4. Know each CLI tool's measurement model before acting on its output

A CSS property that fixes a visual symptom may not affect the layout measurement a CLI uses. For HyperFrames:

- **`npx hyperframes inspect`** measures `getBoundingClientRect` (layout boxes) at sampled timestamps. `overflow:hidden` clips visual but does **not** suppress an inspect overflow; the escape hatch is `data-layout-allow-overflow="true"` on the offender.
- **`npx hyperframes lint`** is a static AST/regex check on the source HTML; runtime DOM is irrelevant.
- **`npx hyperframes validate`** checks data-attribute schemas and id uniqueness, not geometry.
- **Perception** (when puppeteer is installed) measures rendered pixels — different model from inspect.

If you act on a finding without knowing which model produced it, you will fix the wrong thing.

## 5. Mark structural overflow at construction, not after detection

When two or more logical scenes share a single composition (continue runs / `group_wN.html`), every scene-local primary/supporting element stays in the DOM during the OTHER scenes' time windows. Their layout boxes union with the active scene's boxes; the union will almost always overflow the canvas. This is structural, not a defect.

When authoring such a composition, set `data-layout-allow-overflow="true"` on the composition ROOT **and** on every scene-local primary/supporting element from the start. Do not wait for inspect to flag it. Inspect cannot distinguish "currently visible" from "still in layout"; the author must.
