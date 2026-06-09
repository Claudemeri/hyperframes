#!/usr/bin/env node
// Phase 4c (pre-flight) — deterministic gate runner + brief writer.
//
// Sits between assemble-index.mjs / `verify-output.mjs sfx` and the finalize subagent.
// Owns the work that doesn't need LLM judgment:
//
//   1. Pin hyperframes CLI version (read from PROJECT_DIR/package.json) and
//      warm the npx cache with one `--yes hyperframes@<version> --version`
//      call. Subsequent CLI calls (here AND inside the agent) reuse this
//      pinned spec, so npx cache hits cleanly instead of cold-resolving on
//      every gate / snapshot / render. Eliminates the ~90s cache-miss /
//      "Missing module: contrast-audit" rabbit hole observed in prior runs.
//
//   2. Create `caption-overrides.json` empty-array shim if missing. The
//      captions runtime fetches this file at validate time; absence yields a
//      validate ✗ that previously cost finalize ~30s of chasing.
//
//   3. Run lint / validate / inspect once each with the pinned npx. Capture
//      stdout+stderr tails. Set `gates.{lint,validate,inspect}.ok` based on
//      exit code. Doesn't decide what to fix — that's still the agent's job
//      when something fails. But when all three pass, the agent skips Step 1
//      entirely (fast-path).
//
//   4. Compute snapshot timestamps from group_spec.json: per-scene midpoint
//      + high-risk extras (effect-driven heuristic mirroring the agent's old
//      rules). Hand to the agent verbatim so it doesn't recompute, dedupe,
//      or sort.
//
//   5. Run `captions.mjs keepout` (when captions are enabled) — static
//      scan of visual composition files for foreground `position: absolute`
//      elements with `bottom:` values inside the bottom-17% caption band.
//      Findings include Edit-ready old_string / new_string so the finalize
//      agent patches each scene in one Edit call per violation — no Read,
//      no search, no geometry math. Result lands in `caption_keepout`.
//
//   6. Write everything to `finalize_brief.json` for the agent to consume in
//      one Read. Includes bgm_status.json (written by wait-bgm.mjs before
//      assemble) so the agent does not need to probe ps / ls / /tmp logs.
//      `preflight_clean = gates_clean && caption_keepout has 0 violations`
//      — the agent uses this for fast-path decision.
//
// Exit codes:
//   0 — brief written and (gates pass) OR (gates fail with `--allow-gate-failure`
//       set, in which case finalize agent diagnoses from brief.gates[].output_tail)
//   2 — brief written but at least one of lint / validate / inspect produced a
//       hard error (gate exit_code != 0). Pipeline is BLOCKED — orchestrator
//       must STOP and surface gates[].output_tail to the user; do NOT dispatch
//       finalize subagent. Rationale: a worker emitted a real geometric / schema
//       bug (e.g. text overflowing its container). Letting finalize patch over it
//       masks the worker's mental-geometry error. Fix the upstream scene file
//       (or re-dispatch the worker), then re-run preflight.
//   1 — preflight itself crashed (bad arguments, group_spec missing, etc.)
//
// `--allow-gate-failure` flag opts back into the old "always exit 0, let finalize
// decide" behaviour. Use only when you intentionally want finalize to chase
// gate fails (e.g. debugging the agent's diagnostic flow).
//
// `--require-perception` (or env `PLV_REQUIRE_PERCEPTION=1`) escalates a SKIPPED
// rendered-perception check (no puppeteer / no Chrome binary) from a soft
// anomaly to a hard exit-2 block. Use when the run cannot afford to lose the
// only machine check that catches cross-text-collision / cramped-container /
// low-contrast-foreground. CI surfaces will typically set this; interactive
// runs can leave it off so the pipeline still completes without puppeteer.
//
// Usage:
//   node preflight-finalize.mjs --group-spec ./group_spec.json --hyperframes . \
//        [--out ./finalize_brief.json] [--allow-gate-failure] [--require-perception]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- argv ----------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const boolFlag = (name) => argv.includes(`--${name}`);

const groupSpecPath = resolve(flag("group-spec", "./group_spec.json"));
const hyperframesDir = resolve(flag("hyperframes", "."));
const outPath = resolve(flag("out", join(hyperframesDir, "finalize_brief.json")));
const allowGateFailure = boolFlag("allow-gate-failure");
const requirePerception =
  boolFlag("require-perception") || process.env.PLV_REQUIRE_PERCEPTION === "1";

if (!existsSync(groupSpecPath)) {
  console.error(`✗ preflight-finalize: group_spec.json missing at ${groupSpecPath}`);
  process.exit(1);
}
const groupSpec = JSON.parse(readFileSync(groupSpecPath, "utf8"));

// ---------- 1. Resolve pinned hyperframes version ----------
// Try in order:
//   (a) package.json `dependencies` / `devDependencies` (typical when the
//       project locally installs hyperframes)
//   (b) any `hyperframes@<version>` substring in package.json (what
//       `hyperframes init` actually writes today — version is baked into
//       `scripts.{dev,check,render,publish}` strings, not declared as a dep)
//   (c) `latest`
// Using `npx --yes hyperframes@<v>` keys npx cache on version, so all three
// gates + subsequent agent calls reuse the same resolution. The agent gets
// `npx_prefix` in the brief and uses it verbatim.
let pinnedVersion = "latest";
const pkgPath = join(hyperframesDir, "package.json");
if (existsSync(pkgPath)) {
  const raw = readFileSync(pkgPath, "utf8");
  try {
    const pkg = JSON.parse(raw);
    const declared = pkg.dependencies?.hyperframes || pkg.devDependencies?.hyperframes || null;
    if (declared && typeof declared === "string") {
      pinnedVersion = declared.replace(/^[\^~>=<\s]+/, "").trim() || "latest";
    }
  } catch {
    /* fall through to substring scan */
  }
  if (pinnedVersion === "latest") {
    // Substring scan as fallback: matches `hyperframes@<version>` anywhere in
    // the file. Picks the first occurrence (typically `scripts.dev`).
    const m = raw.match(/hyperframes@([\d.][\d.\w\-+]*)/);
    if (m && m[1]) pinnedVersion = m[1];
  }
}
const npxPrefix = `npx --yes hyperframes@${pinnedVersion}`;

// Warm cache + verify install in one shot. If this fails, the agent will see
// gates.lint.ok=false (its `lint` invocation will fail the same way) and can
// diagnose with full context — we don't try to fix it here.
let cliVersionLine = "";
try {
  cliVersionLine = execSync(`${npxPrefix} --version`, {
    cwd: hyperframesDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
} catch (e) {
  cliVersionLine = `(failed to resolve hyperframes@${pinnedVersion}: ${e.message?.split("\n")[0] || "unknown"})`;
}

// ---------- 2. caption-overrides.json shim ----------
// The captions runtime fetches caption-overrides.json at validate time; if
// it 404s, validate logs an error that previously made finalize chase a
// non-issue. An empty `[]` is a no-op override list, semantically identical
// to absent — but the file existing silences the validate noise.
const deterministicFixes = [];
const captionOverridesPath = join(hyperframesDir, "caption-overrides.json");
if (!existsSync(captionOverridesPath)) {
  writeFileSync(captionOverridesPath, "[]\n");
  deterministicFixes.push("caption-overrides.json: created empty [] shim");
}

// ---------- 3. Run gates ----------
// Each gate: capture tail of combined stdout+stderr (~60 lines is enough for
// the agent to spot the problem without overloading dispatch). The agent
// re-runs only the specific gate it needs deeper output from.
function runGate(name, args, { timeoutMs = 90_000 } = {}) {
  const t0 = Date.now();
  const res = spawnSync("npx", ["--yes", `hyperframes@${pinnedVersion}`, ...args], {
    cwd: hyperframesDir,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const dur = ((Date.now() - t0) / 1000).toFixed(2);
  const out = (res.stdout || "") + (res.stderr || "");
  const lines = out.split("\n");
  const tail = lines.slice(-60).join("\n");
  // hyperframes inspect (and lint when there's structured output) prints a
  // closing summary like "1 error(s), 11 warning(s), 2 info(s)". Parse it so
  // brief.gates.<gate>.{errors,warnings,info} surfaces without a second CLI
  // call. Absent / un-parseable → null fields; orchestrator falls back to
  // exit_code for the block decision.
  const summaryMatch = out.match(
    /(\d+)\s+error\(s\)(?:,\s+(\d+)\s+warning\(s\))?(?:,\s+(\d+)\s+info\(s\))?/i,
  );
  const errors = summaryMatch ? Number(summaryMatch[1]) : null;
  const warnings = summaryMatch && summaryMatch[2] != null ? Number(summaryMatch[2]) : null;
  const info = summaryMatch && summaryMatch[3] != null ? Number(summaryMatch[3]) : null;
  return {
    ok: res.status === 0,
    exit_code: res.status,
    duration_s: parseFloat(dur),
    errors,
    warnings,
    info,
    output_tail: tail,
  };
}

// inspect's default --samples is 9. For a typical 30-60s product-launch video
// with 8-12 scenes, that's ~1 sample per scene, which routinely misses
// collisions that only become visible mid-phase animation (e.g. a CTA word
// that overflows the canvas only after its discrete-text-sequence reveal
// fires at local t≈1.9s of a 3.6s scene). 2 scenes × 3 phase-points each is a
// reasonable density / cost tradeoff; on a 40s 10-scene project this catches
// scene_10 CTA overflow that the 9-sample default missed.
const INSPECT_SAMPLES = Math.max(18, (groupSpec.total_scenes || 0) * 2);
const gates = {
  lint: runGate("lint", ["lint"]),
  validate: runGate("validate", ["validate"]),
  inspect: runGate("inspect", ["inspect", "--samples", String(INSPECT_SAMPLES)]),
};
const gatesClean = gates.lint.ok && gates.validate.ok && gates.inspect.ok;

// ---------- 4. Snapshot timestamps ----------
// Per-scene midpoint always. High-risk extras (* 0.75 and * 0.9) when the
// scene is long OR uses a multi-act effect OR the brief signals
// PrimarySubjectTimeline. Mirrors agent's old in-context rule so the agent
// gets the same coverage without recomputing.
const MULTI_ACT_EFFECTS = new Set([
  "multi-phase-camera",
  "coordinate-target-zoom",
  "camera-cursor-tracking",
  "viewport-change",
  "3d-page-scroll",
  "cursor-click-ripple",
  "reactive-displacement",
  "card-morph-anchor",
  "scale-swap-transition",
]);
const HIGH_RISK_BRIEF_RX = /PrimarySubjectTimeline|multi-act|action-payoff|dense/i;

const sceneRows = [];
const tsSet = new Set();
function pushTs(t) {
  // Round to 3 decimals so HF CLI's --at parser doesn't reject and dedupe
  // across scene boundaries works.
  const rounded = Math.round(t * 1000) / 1000;
  tsSet.add(rounded);
}

for (const group of groupSpec.groups || []) {
  for (const sid of group.scene_ids || []) {
    const s = group.scenes?.[sid];
    if (!s) continue;
    const start = Number(s.start_s);
    const dur = Number(s.estimatedDuration_s);
    if (!isFinite(start) || !isFinite(dur) || dur <= 0) continue;
    const midpoint = start + dur * 0.5;
    pushTs(midpoint);
    const effects = Array.isArray(s.effects) ? s.effects : [];
    const brief = String(s.creative_brief || "");
    const highRisk =
      dur >= 8 || effects.some((e) => MULTI_ACT_EFFECTS.has(e)) || HIGH_RISK_BRIEF_RX.test(brief);
    const extras = [];
    if (highRisk) {
      const t075 = start + dur * 0.75;
      const t090 = start + dur * 0.9;
      pushTs(t075);
      pushTs(t090);
      extras.push(Math.round(t075 * 1000) / 1000, Math.round(t090 * 1000) / 1000);
    }
    sceneRows.push({
      scene_id: sid,
      start_s: start,
      duration_s: dur,
      midpoint_s: Math.round(midpoint * 1000) / 1000,
      high_risk_extras_s: extras,
      high_risk: highRisk,
      effects,
    });
  }
}

// Transition seam midpoints — so finalize eyeballs the crossfade/push itself, not
// just scene mids (a 0.4-0.6s seam would otherwise fall between two scene-midpoint
// snapshots and never be captured). The transition plays in [to.start, to.start+dur]
// (extend-outgoing-only), so its visual midpoint is to.start + dur/2.
const sceneStart = new Map();
for (const group of groupSpec.groups || []) {
  for (const sid of group.scene_ids || []) {
    const s = group.scenes?.[sid];
    if (s && isFinite(Number(s.start_s))) sceneStart.set(sid, Number(s.start_s));
  }
}
const transitionRows = [];
for (const t of groupSpec.transitions || []) {
  const toStart = sceneStart.get(t.to_scene || t.to);
  const dur = Number(t.duration_s);
  if (!isFinite(toStart) || !isFinite(dur) || dur <= 0) continue;
  const seamMid = Math.round((toStart + dur * 0.5) * 1000) / 1000;
  pushTs(seamMid);
  transitionRows.push({
    from: t.from,
    to: t.to,
    from_scene: t.from_scene || t.from,
    to_scene: t.to_scene || t.to,
    type: t.type,
    direction: t.direction || null,
    duration_s: dur,
    tier: t.tier,
    seam_mid_s: seamMid,
  });
}

const internalSeamRows = [];
for (const s of groupSpec.internal_seams || []) {
  const globalTime = Number(s.global_time_s);
  if (!isFinite(globalTime)) continue;
  const rounded = Math.round(globalTime * 1000) / 1000;
  pushTs(rounded);
  internalSeamRows.push({
    from_scene: s.from_scene,
    to_scene: s.to_scene,
    visual_id: s.visual_id,
    worker_id: s.worker_id,
    seam_s: rounded,
    local_time_s: s.local_time_s ?? null,
  });
}

const snapshotTimes = [...tsSet].sort((a, b) => a - b);

// ---------- 5. Caption keep-out static check ----------
// Runs the deterministic keepout gate (formerly check-caption-keepout.mjs, now
// `captions.mjs keepout`) as a subprocess and parses its --json result — same
// pure check, just out-of-process so this file doesn't import captions.mjs's
// CLI dispatcher. Skipped automatically when group_spec.captions_enabled !==
// true. Findings include Edit-ready old_string / new_string strings so the
// finalize agent can patch each violation with one Edit call per scene file.
// No Read, no search, no math — the brief encodes the full transform.
let captionKeepout = {
  enabled: groupSpec?.captions_enabled === true,
  scenes_scanned: 0,
  violations: [],
};
try {
  const captionsScript = join(__dirname, "captions.mjs");
  const res = spawnSync(
    process.execPath,
    [
      captionsScript,
      "keepout",
      "--json",
      "--group-spec",
      groupSpecPath,
      "--hyperframes",
      hyperframesDir,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (res.stdout && res.stdout.trim()) captionKeepout = JSON.parse(res.stdout);
} catch {
  // keep the safe default; preflight always exits 0
}
const keepoutClean = captionKeepout.violations.length === 0;

// ---------- 5.5. Rendered-perception check (Tier 1) ----------
// Spawns check-rendered-perception.mjs which loads each composition in headless
// Chrome, injects the brand @font-face block (so text is measured in the real
// display face, not a fallback), seeks the registered timeline at 3 probe times
// (40%/70%/92% of duration) with suppressEvents=false so discrete-text-sequence
// onUpdate callbacks actually fire, then queries the live DOM for:
//   - text-clipping (text natural bbox exceeds parent visible bbox)
//   - depth-layer-ghost-on-long-word (offset depth-layer pair on ≥10-char word
//     at display tier ≥60px)
//   - primary-collision (two data-layout-role="primary" siblings in same act
//     overlap with IoU > 0.05)
//   - cross-text-collision (two DIFFERENT display-tier texts with overlapping
//     bboxes — unannotated headline clash / depth-stack spilling into a neighbour)
//   - primary-offscreen (display-tier text 15-85% clipped by the canvas due to a
//     zoom/camera miscentre — checked EVEN under data-layout-allow-overflow)
//   - font-too-small (rendered font-size < 24px on non-decorative text)
//   - content-cramped-container (a foreground child is pressed against its parent
//     container's border, OR container reports scrollHeight > clientHeight — the
//     signature of a card whose interior was not retuned after the parent shrank)
//   - low-contrast-foreground (text or inline-SVG with WCAG contrast < 2.5:1
//     against the first non-transparent background ancestor — the signature of
//     an asset placed on the wrong surface)
//
// Soft-skips if no headless browser is available (puppeteer / puppeteer-core +
// cached Chrome). Always emits perception_report.json with `skipped: true` in
// that case so this branch stays deterministic. Adds ~25-40s for 8 scenes; the
// gate is informational (preflight always exit 0).
const perceptionReportPath = join(hyperframesDir, "perception_report.json");
let perception = {
  skipped: false,
  scanned: 0,
  skipped_scenes: 0,
  no_timeline: 0,
  violations: [],
  reason: null,
};
try {
  const perceptionScript = join(__dirname, "check-rendered-perception.mjs");
  const res = spawnSync(
    process.execPath,
    [
      perceptionScript,
      "--group-spec",
      groupSpecPath,
      "--hyperframes",
      hyperframesDir,
      "--out",
      perceptionReportPath,
    ],
    { encoding: "utf8", timeout: 240000 },
  );
  if (existsSync(perceptionReportPath)) {
    const r = JSON.parse(readFileSync(perceptionReportPath, "utf8"));
    if (r.skipped) {
      perception = {
        skipped: true,
        scanned: 0,
        skipped_scenes: 0,
        no_timeline: 0,
        violations: [],
        reason: r.reason || "browser unavailable",
      };
    } else {
      perception = {
        skipped: false,
        scanned: r.scenes_scanned || 0,
        failed: r.scenes_failed || 0, // probed but threw — no coverage for those scenes
        skipped_scenes: r.scenes_skipped || 0, // in group_spec but no file/<template>
        no_timeline: r.scenes_no_timeline || 0, // probed at t=0 only (no timeline registered)
        violations: r.violations || [],
        reason: null,
      };
    }
  } else {
    perception = {
      skipped: true,
      scanned: 0,
      skipped_scenes: 0,
      no_timeline: 0,
      violations: [],
      reason: `check-rendered-perception script error (exit ${res.status})`,
    };
  }
} catch (e) {
  perception = {
    skipped: true,
    scanned: 0,
    skipped_scenes: 0,
    no_timeline: 0,
    violations: [],
    reason: String(e.message || e),
  };
}

// Critical perception violations block preflight_clean; font-too-small alone
// doesn't (decorative chips/eyebrows commonly trip it).
const criticalPerceptionViolations = perception.violations.filter(
  (v) => v.type !== "font-too-small",
);
// When perception was skipped we treat it as "clean enough to proceed" by
// default (no puppeteer is a common state during local dev), unless the caller
// explicitly required it via `--require-perception` / `PLV_REQUIRE_PERCEPTION=1`.
// In that mode skipped is NOT clean — preflight_clean turns false and the
// blocking-exit gate below promotes the run to exit 2.
// Coverage honesty: a non-skipped run that crashed scenes (scenes_failed) or
// probed nothing (scanned 0 while scenes exist) did NOT cover its scope — an
// empty violations list then means the probe aborted, NOT that the scenes are
// clean. Gate it on the same terms as a skip (soft by default; blocks under
// --require-perception) so a silent crash / partial run can never read as a pass.
const perceptionPartial =
  !perception.skipped && ((perception.failed || 0) > 0 || perception.scanned === 0);
const perceptionClean =
  perception.skipped || perceptionPartial
    ? !requirePerception
    : criticalPerceptionViolations.length === 0;

const preflightClean = gatesClean && keepoutClean && perceptionClean;

// ---------- 5b. BGM status ----------
// wait-bgm.mjs runs before assemble-index.mjs. Surface its verdict here so the
// finalize agent never has to do ad hoc `ls assets/bgm.wav`, `ps`, or
// `/tmp/bgm-*.log` checks.
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const bgmStatusPath = join(hyperframesDir, "bgm_status.json");
const bgmStatus = readJson(bgmStatusPath);
const bgmPath = groupSpec.bgm_path || "";
const bgmReady = Boolean(bgmPath && existsSync(join(hyperframesDir, bgmPath)));
const bgm = {
  enabled: Boolean(bgmPath),
  path: bgmPath || null,
  ready: bgmReady,
  status_file: existsSync(bgmStatusPath) ? "bgm_status.json" : null,
  status: bgmStatus?.status || (bgmReady ? "ready" : bgmPath ? "missing" : "disabled"),
  provider: bgmStatus?.provider || null,
  mode: bgmStatus?.mode || null,
  log: bgmStatus?.log || null,
  pid: bgmStatus?.pid || null,
  target_duration_s: bgmStatus?.target_duration_s || null,
  seed_duration_s: bgmStatus?.seed_duration_s || null,
  loop_count: bgmStatus?.loop_count || null,
  message:
    bgmStatus?.message ||
    (bgmReady
      ? `BGM ready at ${bgmPath}.`
      : bgmPath
        ? "BGM path declared but file missing."
        : "No BGM path."),
};

// ---------- 5.6. Anomalies (loud, brief-level) ----------
// Things the orchestrator / finalize agent should NOTICE even when they don't
// block preflight. Skipped perception is the canonical example: the check
// COULD have caught cross-text-collision but didn't run, so a "clean" brief
// is misleadingly clean. Other phases can grow this list over time.
const anomalies = [];
if (perception.skipped) {
  anomalies.push({
    code: "perception_check_skipped",
    severity: requirePerception ? "error" : "warning",
    message: `Rendered-perception check did not run (${perception.reason}). text-clipping / depth-layer-ghost / cross-text-collision / primary-offscreen / content-cramped-container / low-contrast-foreground checks are NOT covered for this run${requirePerception ? " — and --require-perception was set, so this BLOCKS preflight" : " — finalize snapshot eye-check is the only remaining safety net for layout collisions, contrast issues, and cramped interiors"}.`,
    actionable_install_command: `cd "${hyperframesDir}" && npm i puppeteer`,
    actionable_alternative: `npm i puppeteer-core && npx hyperframes browser install`,
  });
}
if (perceptionPartial) {
  anomalies.push({
    code: "perception_check_partial",
    severity: requirePerception ? "error" : "warning",
    message: `Rendered-perception ran but covered nothing usable (scenes_failed=${perception.failed || 0}, scenes_scanned=${perception.scanned}). An empty violations list here means the probe crashed/aborted on those scenes, NOT that they are clean${requirePerception ? " — and --require-perception was set, so this BLOCKS preflight" : " — finalize snapshot eye-check is the only remaining safety net"}. See the check-rendered-perception stderr for the per-scene error.`,
  });
}

// ---------- 6. Write brief ----------
const brief = {
  version: 3,
  generated_at: new Date().toISOString(),
  pinned_hyperframes_version: pinnedVersion,
  cli_version_line: cliVersionLine,
  npx_prefix: npxPrefix,
  gates_clean: gatesClean,
  gates,
  bgm,
  caption_keepout: captionKeepout,
  perception: {
    skipped: perception.skipped,
    skip_reason: perception.reason,
    // Surface the install command directly on the perception node so finalize
    // doesn't have to cross-reference brief.anomalies[] to find it.
    install_to_enable: perception.skipped ? `cd "${hyperframesDir}" && npm i puppeteer` : null,
    scenes_scanned: perception.scanned,
    scenes_failed: perception.failed || 0, // probed but threw → no coverage for those scenes
    scenes_not_scanned: perception.skipped_scenes, // no file/<template> → never measured
    scenes_no_timeline: perception.no_timeline, // probed at t=0 only → late reveals unseen
    partial: perceptionPartial, // ran but covered nothing usable (crash / 0 scanned) — treat like skipped
    violations: perception.violations,
    critical_violations_count: criticalPerceptionViolations.length,
  },
  anomalies,
  preflight_clean: preflightClean,
  deterministic_fixes_applied: deterministicFixes,
  snapshot_times_s: snapshotTimes,
  total_duration_s: groupSpec.total_duration_s,
  scenes: sceneRows,
  transitions: transitionRows,
  internal_seams: internalSeamRows,
};

writeFileSync(outPath, JSON.stringify(brief, null, 2) + "\n");

// ---------- stdout summary ----------
console.log(`✓ wrote ${outPath}`);
console.log(`  hyperframes:    ${pinnedVersion} (${cliVersionLine || "version unknown"})`);
console.log(`  preflight_clean: ${preflightClean ? "yes (gates + caption keep-out)" : "no"}`);
console.log(
  `    lint:     ${gates.lint.ok ? "✓" : "✗"} (${gates.lint.duration_s}s, exit ${gates.lint.exit_code})`,
);
console.log(
  `    validate: ${gates.validate.ok ? "✓" : "✗"} (${gates.validate.duration_s}s, exit ${gates.validate.exit_code})`,
);
console.log(
  `    inspect:  ${gates.inspect.ok ? "✓" : "✗"} (${gates.inspect.duration_s}s, exit ${gates.inspect.exit_code})`,
);
if (!captionKeepout.enabled) {
  console.log(`    caption-keepout: skipped (captions_enabled=false)`);
} else if (keepoutClean) {
  console.log(
    `    caption-keepout: ✓ (${captionKeepout.scenes_scanned} scene(s) scanned, 0 violations)`,
  );
} else {
  console.log(
    `    caption-keepout: ✗ (${captionKeepout.violations.length} violation(s) across ${new Set(captionKeepout.violations.map((v) => v.scene_id)).size} scene(s)) — see brief.caption_keepout.violations[] for Edit-ready strings`,
  );
  for (const v of captionKeepout.violations) {
    console.log(
      `      [${v.scene_id}] ${v.selector} (${v.pattern}): element bottom at y=${v.element_bottom_y} → Edit \`${v.edit_old}\` → \`${v.edit_new}\``,
    );
  }
}
if (perception.skipped) {
  // Loud anomaly (was silent in prior versions). Rendered-perception is the
  // only check that catches cross-text-collision / depth-layer-ghost — without
  // it, layout collisions only surface at finalize snapshot eye-check, which
  // is fragile (single-agent, end-of-pipeline, rate-limit prone). Tell the
  // user EXACTLY how to enable it.
  console.log(
    `    perception: ⚠ SKIPPED (${perception.reason}) — cross-text-collision / depth-layer-ghost / primary-offscreen checks DID NOT RUN`,
  );
  console.log(
    `      enable with:  (cd "${hyperframesDir}" && npm i puppeteer)   # or:  npm i puppeteer-core  + install Chrome via \`npx hyperframes browser install\``,
  );
} else if (perception.violations.length === 0) {
  console.log(`    perception: ✓ (${perception.scanned} scene(s) scanned, 0 violations)`);
} else if (criticalPerceptionViolations.length === 0) {
  console.log(
    `    perception: ✓ (${perception.scanned} scene(s) scanned, ${perception.violations.length} non-blocking font-too-small note(s))`,
  );
} else {
  console.log(
    `    perception: ✗ (${criticalPerceptionViolations.length} critical violation(s) across ${new Set(criticalPerceptionViolations.map((v) => v.scene_id)).size} scene(s)) — see brief.perception.violations[]`,
  );
  for (const v of criticalPerceptionViolations) {
    const m = v.metric || {};
    let tag;
    switch (v.type) {
      case "text-clipping":
        tag = `overflow_right=${m.overflow_right_px || 0}px / natural=${m.natural_width_px}px in ${m.visible_width_px}px`;
        if (v.fix_kind === "edit-ready")
          tag += ` [edit-ready → font-size: ${v.recommended_font_size_px}px]`;
        break;
      case "depth-layer-ghost-on-long-word":
        tag = `${m.char_count}-char @ ${m.font_size_px}px, offset=${m.leading_offset_px}px (max ${m.recommended_max_offset_px}px)`;
        break;
      case "primary-collision":
        tag = `act=${m.act} IoU=${m.iou}`;
        break;
      case "cross-text-collision":
        tag = `IoU=${m.iou}, overlap=${(m.overlap_of_smaller * 100).toFixed(0)}% of smaller (${m.a_bbox} ↔ ${m.b_bbox})`;
        break;
      case "primary-offscreen":
        tag = `${m.clipped_pct}% clipped by canvas, center ${m.center_offset_px} (zoom miscentre)`;
        break;
      case "content-cramped-container":
        tag = `container ${m.container_height_px}px tall, ${m.child_count} foreground children, top clearance=${m.top_clearance_px}px, bottom clearance=${m.bottom_clearance_px}px${m.overflowing ? ", overflowing" : ""}`;
        break;
      case "low-contrast-foreground":
        tag = `kind=${m.kind} contrast=${m.contrast_ratio}:1 (fg=${m.foreground_rgb || m.dominant_fill_rgb} on surface ${m.surface_rgb} @ ${m.surface_host_selector})`;
        break;
      default:
        tag = JSON.stringify(m);
    }
    console.log(`      [${v.scene_id}] ${v.type}: "${v.text}" — ${tag}`);
  }
}
if (!perception.skipped && (perception.skipped_scenes || perception.no_timeline)) {
  console.log(
    `    perception coverage: ${perception.skipped_scenes} scene(s) not scanned (no file/template), ${perception.no_timeline} probed at t=0 only (no timeline) — clean ≠ fully covered`,
  );
}
console.log(
  `  snapshot_times: ${snapshotTimes.length} timestamp(s)${transitionRows.length ? ` (incl. ${transitionRows.length} transition seam mid${transitionRows.length > 1 ? "s" : ""})` : ""}`,
);
console.log(
  `  deterministic_fixes: ${deterministicFixes.length === 0 ? "none" : deterministicFixes.join("; ")}`,
);
if (!preflightClean) {
  if (!gatesClean) {
    console.log(
      `\n  ⚠ at least one CLI gate failed — finalize agent will diagnose from brief.gates[].output_tail`,
    );
  }
  if (!keepoutClean) {
    console.log(
      `  ⚠ caption-keepout violations — finalize agent applies brief.caption_keepout.violations[].edit_old → edit_new in each file (one Edit per violation, no Read needed)`,
    );
  }
  if (!perceptionClean) {
    console.log(
      `  ⚠ perception violations — finalize agent reviews brief.perception.violations[] (text-clip / depth-ghost / collision are visual bugs; suggestion field gives the fix direction)`,
    );
  }
}

// ---------- 7. Blocking-exit gate (default — pre-finalize hard stop) ----------
// When any of lint / validate / inspect produced a hard error (gate exit_code
// != 0), we exit non-zero so the orchestrator stops BEFORE dispatching
// finalize. Rationale (see top-of-file): a failing gate is upstream-worker
// signal — text overflowing its container, schema breakage, broken selector
// scope. Letting finalize patch over it masks the worker's mental-geometry
// error and burns finalize tokens on bugs that should round-trip to the worker
// instead. The brief is already on disk; the orchestrator can read
// gates.<gate>.output_tail and decide whether to re-dispatch the worker or
// hand-fix the scene file.
//
// `--allow-gate-failure` reverts to the pre-block behaviour (always exit 0,
// finalize chases the failures). Use only when you intentionally want finalize
// to diagnose gate output (e.g. agent-flow debugging).
if (!gatesClean && !allowGateFailure) {
  const failed = [];
  if (!gates.lint.ok) failed.push(`lint (exit ${gates.lint.exit_code})`);
  if (!gates.validate.ok) failed.push(`validate (exit ${gates.validate.exit_code})`);
  if (!gates.inspect.ok) {
    const cnt =
      gates.inspect.errors != null
        ? `${gates.inspect.errors} error(s)`
        : `exit ${gates.inspect.exit_code}`;
    failed.push(`inspect (${cnt})`);
  }
  console.error(`\n✗ BLOCKED: ${failed.join(", ")} — pipeline must NOT proceed to finalize.`);
  console.error(`  brief: ${outPath}`);
  console.error(
    `  → read brief.gates.<gate>.output_tail to diagnose, then fix the upstream scene file (or re-dispatch the worker).`,
  );
  console.error(
    `  → re-run this script after fix. Override with --allow-gate-failure only if you want finalize to chase the gate errors itself.`,
  );
  process.exit(2);
}

// ---------- 7b. Blocking-exit gate (perception, opt-in) ----------
// When `--require-perception` (or `PLV_REQUIRE_PERCEPTION=1`) is set AND
// rendered-perception was skipped, refuse to proceed. This is the explicit
// CI-grade safety mode — without perception, content-cramped-container /
// low-contrast-foreground / cross-text-collision are uncovered, so a
// "preflight_clean" brief misrepresents reality. Default behaviour is
// unchanged (no flag → skipped is a soft warning, just like before).
if (requirePerception && perception.skipped) {
  console.error(
    `\n✗ BLOCKED: rendered-perception was SKIPPED (${perception.reason}) and --require-perception is set.`,
  );
  console.error(`  brief: ${outPath}`);
  console.error(`  → install puppeteer to enable the check:`);
  console.error(`     (cd "${hyperframesDir}" && npm i puppeteer)`);
  console.error(
    `  → or rerun without --require-perception / unset PLV_REQUIRE_PERCEPTION to fall back to snapshot-only safety net.`,
  );
  process.exit(2);
}
