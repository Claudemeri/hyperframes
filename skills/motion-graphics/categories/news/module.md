# news — category module (search-driven)

Search a real news article → animate it as an **article-highlight** (the agent-opus _article-highlight hook_, reimplemented in HF HTML/CSS). Signature motion: a real article sits soft/blurred, the camera **pulls focus and zooms into one keyword**, and a **marker highlight sweeps across it**. ~6–10s.

## Source (Step 2)

RWA / web search (or `hyperframes capture`) → a real article: `outlet`, `headline`, a `body`/snippet paragraph, the site font. The Director extracts the **keyword** (1–2 words — a product / number / name; the hook). `asset_needs: { kind: news|web, query }`.

## The article-highlight technique (Builder)

1. **Render the article as real HTML** (not a screenshot): `.source` (outlet, accent) + `.headline` + `.body` paragraph; news font (serif body). Real content from search/capture.
2. **Keyword markup** — wrap it for a sweepable highlight:
   ```html
   <span class="kw"><span class="hl"></span><span class="tx">KEYWORD</span></span>
   ```
   `.hl` = highlighter bar (`position:absolute; inset:-2px -7px; transform:scaleX(0); transform-origin:left center`, behind the text); `.tx` sits above it.
3. **Measure** the keyword's real position once (`getBoundingClientRect` → stage-local centre `kx,ky`) — deterministic; no manual bbox math.
4. **Timeline** (the focus-pull):
   - article fades in **soft-blurred** (`filter: blur(8px)`);
   - settles to readable (`blur ≈ 2px`) so the headline reads;
   - **zoom into the keyword** — `#article` (`transform-origin:0 0`) `scale → S`, `x → stageCx − S·kx`, `y → stageCy − S·ky`, `filter: blur → 0`;
   - **marker sweep** — `gsap.to('.kw .hl', { scaleX: 1 })`: the highlight is **swept on AFTER the zoom lands — NEVER pre-applied**;
   - hold (subtle breath).
5. Optional: an attribution/source card; a key-stat count-up (seek-safe `onUpdate`). Export `mp4` or `alpha-overlay`.

**Reference impl:** `samples/news/article-highlight.html`. **Lineage:** agent-opus `hook/workflow/article-highlight-hook` + `article-highlight-search` (canvas) → HF HTML/CSS (crisper text, exact keyword zoom).

## Critical

Highlight is **swept on, not static**. Article is **real HTML** (so the keyword is a real element → exact zoom). Deterministic; honor `references/builder-contract.md`.
