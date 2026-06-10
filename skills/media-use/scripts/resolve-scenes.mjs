#!/usr/bin/env node
// resolve-scenes — the media-use ↔ host-workflow bridge (EMBEDDED model + REUSE, 2026-06-09).
//
// Faceless invents every visual (assetCandidates=[]). This pass sits BETWEEN scriptwriting and the
// build: it finds real-entity scenes and hands faceless a real asset via its existing product-launch
// path (hyperframes-scene.md:189). Zero faceless changes.
//
// Implements the design doc's resolve ORDER (UC3 + UC4 — cross-project reuse):
//   step 2 · global reusable  → before searching, check the PERSONAL scope for an asset whose canonical
//                               `entity` matches this need (e.g. two explainers both needing "Elon Musk"
//                               share ONE durable copy). On hit: reuse, no re-fetch, bump used_in.
//   step 3 · provider search  → miss → resolve.mjs --auto (search + freeze into personal, tagged entity).
//   then: copy ONE consumed copy into <project>/public/ and record it project-locally.
//
// EMBEDDED layout: <project>/public/<basename> (consumed) · <project>/.media-use/manifest.jsonl
// (path = "public/..", == composition path) · ~/.media-use/ (MEDIA_USE_HOME) = durable reusable copies.
//
// Usage: MEDIA_USE_SEARCH_CMD=... [MEDIA_USE_HOME=~/.media-use] node resolve-scenes.mjs --project <dir> [--apply]

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, basename, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { readManifest, writeManifest, renderIndex } from "./_ledger.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const PROJECT = arg("project");
if (!PROJECT || PROJECT === true) {
  console.error("--project <host_project_dir> required");
  process.exit(1);
}
const PERSONAL = process.env.MEDIA_USE_HOME || join(homedir(), ".media-use");
const LEDGER = join(PROJECT, ".media-use");
const APPLY = arg("apply", false) === true;
const HERE = dirname(new URL(import.meta.url).pathname);
const RESOLVE = join(HERE, "resolve.mjs");
const SELECT_RERANK = join(HERE, "select-rerank.mjs");
const projectName = basename(resolvePath(PROJECT));

const nsPath = join(PROJECT, "narrator_scripts.json");
const ns = JSON.parse(readFileSync(nsPath, "utf8"));
const scenes = ns.scenes || [];

// 1) Agentic detection: which scenes depict a real entity? Emit a precise query AND a canonical entity
//    name (the reuse key — must be identical across videos, e.g. "Elon Musk" for both Tesla and SpaceX).
const sceneList = scenes
  .map((s) => `${s.sceneNumber}. [${s.sceneName}] ${s.narrativeIntent?.keyMessage || ""} :: ${(s.script || "").replace(/<[^>]+>/g, "").slice(0, 180)}`)
  .join("\n");
const judgePrompt = `You decide which explainer scenes would be served by a REAL fetchable visual — a real PERSON, a real BRAND/LOGO, a real PRODUCT UI/screenshot, or a recognizable real PLACE. Abstract/conceptual scenes must NOT get a real asset.

SCENES:
${sceneList}

For each real-entity scene emit: a precise search query, the media type, a short description, and a CANONICAL entity name. The entity name is a REUSE KEY: use the bare proper name only ("Elon Musk", "OpenAI", "iPhone", "the Moon") with NO qualifiers or context, so the SAME entity in two different videos produces the SAME string.

MEDIA TYPE — important: use "image" for a real brand/company logo (Tesla, OpenAI, Microsoft), a photo, a portrait, a product shot, or a screenshot — these are all findable as IMAGES. Use "icon" ONLY for a generic abstract symbol that has no real brand (a rocket, a gear, a checkmark). A real company's logo is an IMAGE, never an icon.

Reply with ONE line of JSON ONLY:
{"needs":[{"scene":<n>,"query":"<query>","media":"image|icon","description":"<=10 words","entity":"<canonical name>"}]}
If no scene depicts a real entity, reply {"needs":[]}.`;

function judge(prompt) {
  let raw;
  try {
    raw = execFileSync(
      "claude",
      ["-p", prompt, "--max-turns", "1", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "bypassPermissions"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (e) {
    raw = e.stdout || "";
  }
  const m = raw.match(/\{[\s\S]*"needs"[\s\S]*\}/);
  if (!m) throw new Error("judge returned no parseable JSON: " + raw.slice(0, 200));
  return JSON.parse(m[0]).needs || [];
}

const needs = judge(judgePrompt);
console.error(`[resolve-scenes] judge flagged ${needs.length}/${scenes.length} scenes as real-entity`);

mkdirSync(join(PROJECT, "public"), { recursive: true });
mkdirSync(join(LEDGER, "reports"), { recursive: true });
const projManifest = join(LEDGER, "manifest.jsonl");
const injected = [];

// Bump a personal-scope asset's reuse bookkeeping for this project (UC3: usage_count / used_in).
function bumpPersonalUsage(assetId) {
  const recs = readManifest(PERSONAL);
  const rec = recs.find((r) => r.asset_id === assetId);
  if (!rec) return;
  rec.used_in = Array.from(new Set([...(rec.used_in || []), projectName]));
  rec.usage_count = rec.used_in.length;
  writeManifest(PERSONAL, recs);
  renderIndex(PERSONAL);
}

// text-only model call (isolated), used for the reuse judgment.
function claudeJSON(prompt) {
  try {
    return execFileSync("claude", ["-p", prompt, "--max-turns", "1", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "bypassPermissions"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    return (e.stdout || "").toString();
  }
}

// resolve order step 2 (REUSE) as a MODEL judgment, not exact-string. Exact canonical-entity match is the
// fast path (common case, e.g. Musk==Musk, no model call); fuzzy cases ask the model "same real entity?".
function reuseJudge(entity, query, personalRecs) {
  const pool = personalRecs.filter((r) => r.status === "ready" && r.reusable);
  if (!pool.length || !entity) return null;
  const exact = pool.find((r) => r.entity && r.entity.toLowerCase() === entity.toLowerCase());
  if (exact) return exact;
  const list = pool.map((r) => `${r.asset_id} · entity="${r.entity || "?"}" · ${(r.description || "").slice(0, 60)}`).join("\n");
  const raw = claudeJSON(`A new scene needs an asset for the real entity "${entity}" (search query "${query}"). Do any of these already-owned assets depict the SAME real entity (so we reuse it instead of re-fetching)?\n${list}\nReply ONE line of JSON: {"reuse":"<asset_id or none>"}`);
  const m = raw.match(/\{[^{}]*"reuse"[^{}]*\}/);
  const id = m ? JSON.parse(m[0]).reuse : "none";
  return id && id !== "none" ? pool.find((r) => r.asset_id === id) || null : null;
}

for (const need of needs) {
  const scene = scenes.find((s) => s.sceneNumber === need.scene);
  if (!scene) continue;
  const isIcon = need.media === "icon";
  const entity = (need.entity || need.query || "").trim();

  // resolve order step 2 — global reusable (MODEL judgment).
  const personalRecs = readManifest(PERSONAL);
  const hit = reuseJudge(entity, need.query, personalRecs);

  let personalId, personalPath, sourceUrl, provider, selectReason;
  const reused = !!hit;
  if (hit) {
    personalId = hit.asset_id;
    personalPath = hit.path;
    sourceUrl = hit.provenance?.source_url;
    provider = hit.provenance?.provider;
    selectReason = "reused (same entity)";
  } else {
    // step 3 — SELECT (agent-native): text-rerank picks the best candidate (search → vision-caption each →
    // text-layer rerank), then freeze the picked URL into personal. Falls back to --auto top-1 if needed.
    let pickedUrl = null, pickedDesc = null;
    try {
      const sout = execFileSync("node", [SELECT_RERANK, "--workspace", PERSONAL, "--query", need.query, "--media", isIcon ? "icon" : "image", "--num", "4"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 240000 });
      const sel = JSON.parse(sout.slice(sout.indexOf("{"), sout.lastIndexOf("}") + 1));
      pickedUrl = sel.picked_url || null;
      selectReason = sel.reason || null;
      pickedDesc = sel.picked_description || null; // the stored text caption → goes into the manifest description
    } catch (e) {
      console.error(`[resolve-scenes] scene ${need.scene} select-rerank error: ${(e.stderr || e.message || "").toString().slice(0, 100)}`);
    }
    const freezeArgs = pickedUrl
      ? [RESOLVE, "--workspace", PERSONAL, "--type", isIcon ? "icon" : "image", "--url", pickedUrl, "--entity", entity, "--intent", need.query, ...(pickedDesc ? ["--desc", pickedDesc] : [])]
      : [RESOLVE, "--workspace", PERSONAL, "--type", isIcon ? "icon" : "image", "--intent", need.query, "--auto", "--entity", entity];
    let out;
    try {
      out = execFileSync("node", freezeArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
    } catch (e) {
      console.error(`[resolve-scenes] scene ${need.scene} freeze error for "${need.query}": ${(e.stderr || e.message || "").toString().slice(0, 120)}`);
      injected.push({ scene: need.scene, sceneName: scene.sceneName, entity, query: need.query, media: need.media, failed: true, reason: "freeze-error" });
      continue;
    }
    const r = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    if (!r.ok || !r.path) {
      console.error(`[resolve-scenes] scene ${need.scene}: no asset for "${need.query}"`);
      injected.push({ scene: need.scene, sceneName: scene.sceneName, entity, query: need.query, media: need.media, failed: true, reason: "no-candidates" });
      continue;
    }
    personalId = r.registered;
    personalPath = r.path;
    sourceUrl = r.source_url;
    provider = isIcon ? "noun_project" : "google_images";
  }

  const base = basename(personalPath);
  const rec = {
    asset_id: personalId,
    type: "image",
    path: `public/${base}`,
    source: "search",
    reused, // true = served from the personal/global reusable scope, no re-fetch
    status: "ready",
    description: need.description || need.query,
    entity: entity || undefined,
    tags: isIcon ? ["image", "icon"] : ["image"],
    provenance: { provider, prompt: need.query, source_url: sourceUrl, derived_from: `personal:${personalId}` },
  };
  if (APPLY) {
    copyFileSync(join(PERSONAL, personalPath), join(PROJECT, "public", base));
    bumpPersonalUsage(personalId);
    appendFileSync(projManifest, JSON.stringify(rec) + "\n");
    const repSrc = join(PERSONAL, `.media-use/reports/resolve_${personalId}.json`);
    if (existsSync(repSrc)) copyFileSync(repSrc, join(LEDGER, "reports", `resolve_${personalId}.json`));
    // append (a scene may flag multiple entities, e.g. a person AND a brand — keep all; worker features the primary)
    if (!Array.isArray(scene.assetCandidates)) scene.assetCandidates = [];
    scene.assetCandidates.push({ path: rec.path, description: rec.description });
  }
  injected.push({ scene: need.scene, sceneName: scene.sceneName, entity, query: need.query, media: need.media, path: rec.path, reused, personal_id: personalId, source_url: sourceUrl, select_reason: selectReason });
}

if (APPLY) {
  const recs = existsSync(projManifest)
    ? readFileSync(projManifest, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const rows = recs
    .map((r) => `| ${r.asset_id} | ${r.entity || "—"} | ${r.path} | ${r.reused ? "reused" : "search"} | ${(r.description || "").replace(/\|/g, "\\|").slice(0, 50)} |`)
    .join("\n");
  writeFileSync(
    join(LEDGER, "index.md"),
    `# media-use — project assets (generated)\n\n> Consumed copies in \`public/\`; durable reusable originals + traces in \`${PERSONAL}\`.\n\n| asset_id | entity | path | source | description |\n| --- | --- | --- | --- | --- |\n${rows}\n\n_${recs.length} assets (${recs.filter((r) => r.reused).length} reused from personal scope)_\n`,
  );
  writeFileSync(nsPath, JSON.stringify(ns, null, 2) + "\n");
  const ok = injected.filter((i) => !i.failed);
  console.error(`[resolve-scenes] APPLIED: ${ok.length} scenes (${ok.filter((i) => i.reused).length} reused, ${injected.filter((i) => i.failed).length} failed) → ${projManifest}`);
} else {
  console.error(`[resolve-scenes] DRY RUN. would inject ${injected.length} (${injected.filter((i) => i.reused).length} reused).`);
}

console.log(JSON.stringify({ project: resolvePath(PROJECT), personal: PERSONAL, applied: APPLY, scenes: scenes.length, injected }, null, 2));
