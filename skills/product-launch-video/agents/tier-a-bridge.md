# Tier-A Shared-Element Bridge (read on demand)

Read this ONLY when your dispatch carries a non-null `shared_element_bridge` (rare — Tier-A is a premium opt-in; most films are Tier-B everywhere). This is the contract for a continuous morph **between two scenes** (e.g. card→avatar, waveform→search box). Unlike Tier-B: **you write the morph inside the scene**, and the harness only crossfades the outer shell at the seam. Therefore both scenes must align on one shared **handoff pose**.

Dispatch field:

```
shared_element_bridge:
  bridge_id: <kebab-id>      # shared by both scenes, put into data-bridge-id
  role: from | to            # whether this scene exits (from) or enters (to)
  partner: <other scene_id>  # the other scene
  seam_duration_s: <float>   # seam crossfade duration (default 0.25); entering scene must HOLD for this long
```

## Shared contract (both scenes)

- Put an element with `data-bridge-id="<bridge_id>"` in the DOM (**attribute exactly as-is; do not prefix it with `s<N>-`** — it must remain stable across scenes; class/id still get normal prefixes). In both scenes this element is the **same visual object** (same content/shape semantics).
- Agree on a **handoff pose** for the element: a concrete screen bbox (left/top/width/height) + appearance (border radius/background color). The outgoing scene reaches this pose at its end, and the incoming scene starts from it — geometry matches **at the seam**, so the crossfade reads as the same element rather than two ghosts.
- Express the handoff pose in **each scene's own coordinates** (the two sub-compositions do not share a transform origin; do not align with `x/y` offsets. Write left/top/width/height directly, or an equivalent final transform).

## `role: from` (outgoing scene)

- The element enters + displays normally according to this scene's story.
- In the **last ~0.5s** of your timeline, tween the element to the handoff pose (move to agreed position, scale, adjust radius); fade/exit the scene's **other** content (headlines, etc.) at the same time.
- End with the element **held in the handoff pose** through the end of `data-duration`.

## `role: to` (incoming scene)

- The element is **initially** placed at the handoff pose (= outgoing final bbox/appearance, written in this scene's coordinates).
- **Seam HOLD:** for the first `seam_duration_s` seconds, **do not tween this bridge element** (keep it still in the handoff pose, covering the outer crossfade window — otherwise the seam shows two misaligned ghosts).
- After `seam_duration_s`, tween it to its final resting position in this scene, and let other scene content enter.

## Morphing between different bboxes — convert to GSAP transform

When the handoff bboxes differ (e.g. scene_2 ink line `(720,760,480,6)` → scene_3 editor underline `(200,600,700,4)`), the first instinct is `tl.to(bridge, { left: 200, top: 600, width: 700, height: 4 })` — **forbidden** (only `x/y/scale/scaleX/scaleY/rotation/opacity` may be tweened). Convert the bbox delta:

- Center movement: `dx = newCenterX − oldCenterX`, `dy = newCenterY − oldCenterY` → `x: dx, y: dy`
- Shape scale: `scaleX = newWidth / oldWidth`, `scaleY = newHeight / oldHeight`
- Pair with `transform-origin: 50% 50%` (set once in CSS or `gsap.set`)
- Example (ink line above): `x: -410, y: -161, scaleX: 1.458, scaleY: 0.667`. Done.

## Bridge element "initial hidden" must use `gsap.set` — CSS `opacity: 0` / `display: none` is forbidden

`transitions.mjs check-bridge` scans static CSS; when it sees `opacity: 0` on the bridge element, it classifies it as statically hidden → fatal. Leave CSS opacity at 1 (or omit it), and initialize with `gsap.set` at the top of the timeline:

```js
// Tier-A bridge initial state — gsap.set (not CSS opacity:0) so check-bridge sees it as statically visible
gsap.set("#s<N>-bridge", { opacity: 1, rotation: <baked-tilt>, scale: 1, transformOrigin: "50% 50%" });
```

(For an element that must not appear until later in its scene, use `gsap.set(..., { opacity: 0 })` — runtime hiding is invisible to the static scan.)

## Validation

`transitions.mjs check-bridge` (Step 6) deterministically checks that both scenes contain an element with the same `data-bridge-id` and that it is not statically hidden. Visual alignment of the handoff pose is checked by finalize in seam snapshots — **you must personally align the handoff pose values** (outgoing final left/top/w/h == incoming initial left/top/w/h).

**Do not:** touch `index.html` / the outer shell from inside a scene; prefix the `data-bridge-id` attribute with `s<N>-`; animate the incoming bridge element during the seam window; write CSS `opacity: 0` / `display: none` for the bridge element (use `gsap.set` instead).
