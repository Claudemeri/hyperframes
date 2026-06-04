// media-use ledger helpers — zero-dependency node ESM.
// The workspace is the interface: assets/manifest.jsonl is the source of truth,
// assets/index.md is a generated, agent-readable view. These helpers are the thin
// bookkeeping layer behind the setup / organize / find verbs.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export const SUBDIRS = [
  "assets/raw",
  "assets/generated",
  "assets/processed",
  "assets/audio/bgm",
  "assets/audio/sfx",
  "assets/preview",
  ".media-use/reports",
  ".media-use/snippets",
];

export const REQUIRED = ["asset_id", "type", "path", "source", "status"];

export function paths(ws) {
  return { ws, manifest: join(ws, "assets/manifest.jsonl"), index: join(ws, "assets/index.md") };
}

export function ensureWorkspace(ws) {
  for (const d of SUBDIRS) mkdirSync(join(ws, d), { recursive: true });
  const p = paths(ws);
  if (!existsSync(p.manifest)) writeFileSync(p.manifest, "");
  if (!existsSync(p.index)) renderIndex(ws);
  return p;
}

export function readManifest(ws) {
  const { manifest } = paths(ws);
  if (!existsSync(manifest)) return [];
  return readFileSync(manifest, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function writeManifest(ws, records) {
  const { manifest } = paths(ws);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

// Upsert by asset_id (re-runs are idempotent), then regenerate the index.
export function upsert(ws, record) {
  for (const k of REQUIRED) {
    if (record[k] === undefined || record[k] === null || record[k] === "") {
      throw new Error(`AssetRecord missing required field: ${k}`);
    }
  }
  const records = readManifest(ws);
  const i = records.findIndex((r) => r.asset_id === record.asset_id);
  if (i >= 0) records[i] = record;
  else records.push(record);
  writeManifest(ws, records);
  renderIndex(ws);
  return record;
}

export function renderIndex(ws) {
  const { index } = paths(ws);
  const records = readManifest(ws);
  const cell = (s) =>
    String(s ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ");
  const rows = records
    .map((r) => {
      const src = r.provenance?.derived_from
        ? `${r.source} (← ${r.provenance.derived_from})`
        : r.source;
      return `| ${cell(r.asset_id)} | ${cell(r.type)} | ${cell(r.path)} | ${cell(src)} | ${cell(r.usage_intent || "—")} | ${cell(r.status)} | ${cell((r.description || "").slice(0, 80))} |`;
    })
    .join("\n");
  const counts = {};
  for (const r of records) counts[r.source] = (counts[r.source] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(" · ");
  const md =
    `# Assets — index (generated)\n\n` +
    `> Generated from \`assets/manifest.jsonl\` by media-use. Do not hand-edit.\n\n` +
    `| asset_id | type | path | source | usage_intent | status | description |\n` +
    `| --- | --- | --- | --- | --- | --- | --- |\n` +
    `${rows}\n\n` +
    `_${records.length} assets${summary ? ` · ${summary}` : ""}_\n`;
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, md);
  return index;
}

export function find(ws, { type, tag, query } = {}) {
  let recs = readManifest(ws);
  if (type) recs = recs.filter((r) => r.type === type);
  if (tag) recs = recs.filter((r) => (r.tags || []).includes(tag));
  if (query) {
    const q = String(query).toLowerCase();
    recs = recs.filter((r) =>
      `${r.asset_id} ${r.description || ""} ${(r.tags || []).join(" ")}`.toLowerCase().includes(q),
    );
  }
  return recs;
}

// Minimal --key value / --flag parser (no deps).
export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      a[k] = next !== undefined && !next.startsWith("--") ? argv[++i] : true;
    }
  }
  return a;
}
