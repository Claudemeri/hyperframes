#!/usr/bin/env node
// resolve — one procedure over search / generate / fetch, so the agent doesn't micro-manage providers.
// Honors the decision order in references/resolve.md: reuse / search before generate; freeze before reference.
// The hard part is SELECTION, not the call — so bgm search hands candidates back for the agent to pick,
// rather than silently taking the first hit (Bin, 2026-06-04).
//
// v0.1 wedge (per James's review, 2026-06-03): bgm (heygen audio catalog) + tts (hyperframes, free/local).
//
// Usage:
//   node resolve.mjs --workspace <dir> --type bgm --intent "subtle confident tech launch" [--limit 8]
//       → search mode: prints existing project matches + ranked candidates; registers nothing (you pick)
//   node resolve.mjs --workspace <dir> --type bgm --intent "..." --auto            → take top-1, download, register
//   node resolve.mjs --workspace <dir> --type bgm --intent "..." --pick <id|index> → take that one, download, register
//   node resolve.mjs --workspace <dir> --type tts --text "Welcome to Acme" [--voice af_heart] [--id voice_001]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ensureWorkspace, upsert, find, parseArgs } from "./_ledger.mjs";

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: String(msg) }));
  process.exit(1);
}
// Stable, count-based id matching the workspace convention (bgm_001, voice_001).
function nextId(ws, type, prefix) {
  return `${prefix}_${String(find(ws, { type }).length + 1).padStart(3, "0")}`;
}

const a = parseArgs(process.argv.slice(2));
const ws = a.workspace || ".media-use-workspace";
ensureWorkspace(ws);
const type = a.type;

if (type === "bgm") {
  const intent = a.intent && a.intent !== true ? a.intent : a.query;
  if (!intent || intent === true) fail("--intent (or --query) is required for --type bgm");

  // step 1 (resolve.md): reuse — surface existing project bgm so we don't re-fetch needlessly.
  const existing = find(ws, { type: "bgm", query: intent }).map((r) => ({
    asset_id: r.asset_id,
    path: r.path,
    description: r.description,
  }));

  // step 3: provider search — heygen audio catalog (semantic, ranked, pre-signed URLs).
  const limit = a.limit && a.limit !== true ? String(a.limit) : "8";
  let res;
  try {
    res = JSON.parse(
      run("heygen", ["audio", "sounds", "list", "--query", intent, "--limit", limit]),
    );
  } catch (e) {
    fail(`heygen audio search failed: ${e.message || e}`);
  }
  const tracks = (res.data || []).map((t, i) => ({
    index: i,
    id: t.id,
    name: t.name,
    description: t.description,
    duration: t.duration,
    score: t.score,
    audio_url: t.audio_url,
  }));

  // SELECTION is agentic unless --auto / --pick (resolve.md: "get the selection right, not just the call").
  let chosen = null;
  if (a.auto) chosen = tracks[0];
  else if (a.pick !== undefined && a.pick !== true) {
    const pick = String(a.pick);
    chosen = tracks.find((t) => t.id === pick) || tracks[Number(pick)];
  }
  if (!chosen) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "search",
          type: "bgm",
          intent,
          existing,
          candidates: tracks.map((t) => ({
            index: t.index,
            id: t.id,
            name: t.name,
            description: t.description,
            duration: t.duration,
            score: t.score,
          })),
          hint: "review candidates, then re-run with --pick <id> (or --auto for top-1)",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // fetch + freeze (resolve.md: resolve first, then freeze — never let a composition reference a signed URL).
  const ext = (chosen.audio_url.split("?")[0].match(/\.(\w+)$/) || ["", "mp3"])[1];
  const asset_id = a.id && a.id !== true ? a.id : nextId(ws, "bgm", "bgm");
  const rel = `assets/audio/bgm/${asset_id}.${ext}`;
  const out = join(ws, rel);
  mkdirSync(dirname(out), { recursive: true });
  const r = await fetch(chosen.audio_url);
  if (!r.ok) fail(`download failed: HTTP ${r.status}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));

  const saved = upsert(ws, {
    asset_id,
    type: "bgm",
    path: rel,
    source: "search",
    status: "ready",
    description: chosen.description || chosen.name || intent,
    tags: ["bgm"],
    provenance: { provider: "heygen.audio.sounds", prompt: intent },
    metadata: { duration: chosen.duration },
  });
  console.log(
    JSON.stringify(
      { ok: true, mode: "resolve", registered: saved.asset_id, path: rel, track: chosen.name },
      null,
      2,
    ),
  );
} else if (type === "tts") {
  const text = a.text;
  if (!text || text === true) fail("--text is required for --type tts");
  const voice = a.voice && a.voice !== true ? a.voice : "af_heart";
  const asset_id = a.id && a.id !== true ? a.id : nextId(ws, "voice", "voice");
  const rel = `assets/audio/voice/${asset_id}.wav`;
  const out = join(ws, rel);
  mkdirSync(dirname(out), { recursive: true });
  try {
    run("hyperframes", ["tts", text, "-o", out, "-v", voice, "--json"]);
  } catch (e) {
    fail(`hyperframes tts failed: ${e.message || e}`);
  }
  const saved = upsert(ws, {
    asset_id,
    type: "voice",
    path: rel,
    source: "generated",
    status: "ready",
    description: `TTS: ${String(text).slice(0, 80)}`,
    tags: ["voice", "tts"],
    provenance: { provider: "hyperframes.tts", model: voice, prompt: String(text).slice(0, 200) },
  });
  console.log(
    JSON.stringify({ ok: true, mode: "resolve", registered: saved.asset_id, path: rel }, null, 2),
  );
} else {
  fail(`unsupported --type '${type}'. v0.1 wedge: bgm | tts (see references/resolve.md)`);
}
