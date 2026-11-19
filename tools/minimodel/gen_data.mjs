#!/usr/bin/env node
// Training-data generator for the SketchCraftAI minimodel (Phase 2). Writes (state, request -> MCP command list)
// pairs as JSONL. Every pair is VERIFIED before it is kept:
//   1. every command is in the lib/spec.mjs table (the agent allowlist) and matches its field types;
//   2. a fresh `sketchcraft mcp` (untrusted agent policy, scratch HOME and document) runs the starting model and
//      then the commands, and every command must be accepted;
//   3. the engine's info/parts/faces after the run must pass the template's check, which is computed from the
//      request's numbers (lib/check.mjs). A question must use a read-only command and change nothing. The answer
//      runs inside begin_batch/end_batch, as the app will run it, and ONE undo must then restore the model;
//   4. lib/heldout.mjs: the pair must not collide with the eval set (exact, same sentence pattern, light
//      rewording, or the same gold answer). The eval set stays test-only.
// Anything that fails is dropped and counted, never fixed by hand.
//
//   node gen_data.mjs --n 4000 [--seed 1] [--out DIR] [--jobs 4] [--sample tools/minimodel/data/sample.jsonl] [--strict]
//   node gen_data.mjs --check DIR/train.jsonl     re-run the held-out rules over an existing file (exit 1 on any hit)
//
// Env: SKETCHCRAFT_BIN (engine), MINIMODEL_SCRATCH (scratch folders; each run's folder is deleted).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./lib/engine.mjs";
import { grade } from "./lib/check.mjs";
import { INSPECT, fixtureDesc, sig } from "./lib/run_case.mjs";
import { COMMANDS } from "./lib/spec.mjs";
import { makeHeldout, norm } from "./lib/heldout.mjs";
import { TEMPLATES, dictate, makeRng } from "./gen/templates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const heldout = makeHeldout();

if (flag("check")) {
  const rows = readFileSync(flag("check"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hits = rows.map((x) => ({ x, h: heldout(x.request, x.fixture_kind, x.commands) })).filter((y) => y.h.bad);
  for (const { x, h } of hits.slice(0, 20)) console.log(`HIT ${h.bad} vs ${h.evalId}: ${x.request}`);
  const sims = rows.map((x) => heldout(x.request, x.fixture_kind, x.commands).sim);
  console.log(`${rows.length} pairs, ${hits.length} held-out hits; word-cosine to the closest eval request: >=0.6 ${sims.filter((s) => s >= 0.6).length}, >=0.8 ${sims.filter((s) => s >= 0.8).length}`);
  process.exit(hits.length ? 1 : 0);
}

// the table as the model sees it (with `as` allowed on insert, as in --fix-schema)
const TABLE = Object.fromEntries(COMMANDS.map(([n, f]) => [n, n === "insert" ? { ...f, as: "s?" } : f]));
const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isId = (v) => Number.isInteger(v) || (typeof v === "string" && /^@[A-Za-z0-9_]{1,32}$/.test(v));
const TYPECHECK = {
  v3: isV3, n: (v) => typeof v === "number" && Number.isFinite(v), i: (v) => Number.isInteger(v) && v >= 1 && v <= 200, s: (v) => typeof v === "string" && v.length <= 40, b: (v) => typeof v === "boolean",
  id: isId, ids: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every(isId), pts: (v) => Array.isArray(v) && v.length >= 2 && v.length <= 24 && v.every(isV3),
  fac: (v) => (typeof v === "number" && Number.isFinite(v)) || isV3(v), roofkind: (v) => ["gable", "hip", "shed"].includes(v),
  asset: (v) => ["door", "window", "garage_door", "tree", "palm", "car", "streetlight", "bench", "hydrant"].includes(v),
};
function schemaErr(cmds) {
  if (!Array.isArray(cmds) || cmds.length < 1 || cmds.length > 40) return "command count";
  for (const c of cmds) {
    const f = TABLE[c.cmd];
    if (!f) return `not in table: ${c.cmd}`;
    for (const k of Object.keys(c)) if (k !== "cmd" && !(k in f)) return `${c.cmd}: unknown field ${k}`;
    for (const [k, code] of Object.entries(f)) {
      if (!(k in c)) { if (!code.endsWith("?")) return `${c.cmd}: missing ${k}`; continue; }
      if (k === "as") { if (!/^@?[A-Za-z0-9_]{1,32}$/.test(c[k])) return `${c.cmd}: bad as`; continue; }
      if (!TYPECHECK[code.replace("?", "")](c[k])) return `${c.cmd}: bad ${k}`;
    }
  }
  return null;
}

// Where an inserted asset ends up is not in info/parts, only in the overall bounds. `check.inst_at` (generator only,
// not a lib/check.mjs key) lists the inserts a request asked for: [{asset, at, rotate?}]. The expected bounds are the
// starting model's bounds joined with each asset's own box (probed once, inserted at the origin) moved to `at`.
const probes = new Map();
async function assetBox(asset, rotate = 0) {
  const k = `${asset}|${rotate}`;
  if (!probes.has(k)) {
    const s = await new Session().init();
    try { await s.run([{ cmd: "insert", asset, at: [0, 0, 0], ...(rotate ? { rotate } : {}) }]); probes.set(k, (await s.inspect()).info.bounds); } finally { s.close(); }
  }
  return probes.get(k);
}
async function instBounds(list, start) {
  let min = start ? [...start.min] : null, max = start ? [...start.max] : null;
  for (const { asset, at, rotate } of list) {
    const b = await assetBox(asset, rotate);
    const bmin = b.min.map((v, i) => v + at[i]), bmax = b.max.map((v, i) => v + at[i]);
    min = min ? min.map((v, i) => Math.min(v, bmin[i])) : bmin;
    max = max ? max.map((v, i) => Math.max(v, bmax[i])) : bmax;
  }
  return { min, max };
}

async function verify(ex) {
  const s = await new Session().init();
  try {
    if (ex.fx) {
      const f = await s.run(ex.fx.setup);
      if (!f.ok) return `setup: ${f.error}`;
    }
    const before = await s.inspect();
    // as the app will run it: the whole answer is ONE undo step (begin_batch/end_batch). An answer that is itself an
    // undo is run as it is.
    const wrap = !ex.commands.some((c) => c.cmd === "undo");
    const ran = await s.run(wrap ? [{ cmd: "begin_batch" }, ...ex.commands, { cmd: "end_batch" }] : ex.commands);
    const r = wrap ? { ...ran, replies: ran.replies.slice(1, -1), failedAt: ran.failedAt == null ? null : ran.failedAt - 1 } : ran;
    if (!r.ok) return `engine: command ${r.failedAt} ${r.error || r.stopped}`;
    const after = await s.inspect();
    const { inst_at, ...check } = ex.check;
    const errs = grade(check, after, r.replies);
    if (inst_at) {
      const want = await instBounds(inst_at, before.info.bounds);
      const got = after.info.bounds;
      for (const k of ["min", "max"]) for (let i = 0; i < 3; i++) if (Math.abs(got[k][i] - want[k][i]) > 0.06) errs.push(`insert bounds ${k}[${"xyz"[i]}] ${got[k][i].toFixed(2)}, want ${want[k][i].toFixed(2)}`);
    }
    if (ex.check.readonly) {
      if (!ex.commands.every((c) => INSPECT.has(c.cmd))) errs.push("question used a changing command");
      if (sig(before) !== sig(after)) errs.push("question changed the model");
    }
    if (errs.length) return `check: ${errs[0]}`;
    if (wrap && !ex.check.readonly) {
      // one Undo must take the whole answer back
      const u = await s.run([{ cmd: "undo" }]);
      if (!u.ok || sig(await s.inspect()) !== sig(before)) return "one-undo: a single undo did not restore the model";
    }
    return null;
  } finally { s.close(); }
}

const N = Number(flag("n", 4000)), seed = Number(flag("seed", 1)), jobs = Number(flag("jobs", 4)), strict = !!flag("strict");
const out = flag("out", "/private/tmp/claude-501/minimodel-data");
mkdirSync(out, { recursive: true });
const r = makeRng(seed);
const evalStates = new Set(Object.values(JSON.parse(readFileSync(join(here, "eval/fixtures.json"), "utf8"))));

// bucket mix: ~28% accessibility-style, ~3% out of scope, the rest core split 40/40/20 easy/medium/hard
const byBucket = { a11y: TEMPLATES.filter((t) => t.cat === "a11y"), scope: TEMPLATES.filter((t) => t.cat === "scope"), easy: [], medium: [], hard: [] };
for (const t of TEMPLATES.filter((t) => t.cat === "core")) byBucket[t.tier].push(t);
function pickTemplate() {
  const u = r.f();
  const b = u < 0.28 ? "a11y" : u < 0.31 ? "scope" : (() => { const v = r.f(); return v < 0.4 ? "easy" : v < 0.8 ? "medium" : "hard"; })();
  return r.pick(byBucket[b]);
}

const stats = { tried: 0, kept: 0, drop: {}, heldout: {}, byTemplate: {}, tiers: {}, cats: {}, simHi: 0 };
const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
const seen = new Set();
const kept = [];
const closest = [];
const failures = [];

async function one() {
  const t = pickTemplate();
  stats.tried++;
  let ex;
  try { ex = t.fn(r); } catch (e) { bump(stats.drop, "template error"); failures.push(`${t.name}: ${e.message}`); return; }
  if (!ex) { bump(stats.drop, "template declined"); return; }
  ex.fx ??= null;
  if (ex.fx && evalStates.has(ex.fx.desc)) { bump(stats.drop, "state equals an eval fixture"); return; }
  if (t.cat === "a11y" || r.chance(0.1)) ex.request = dictate(r, ex.request);
  const key = norm(ex.request) + "|" + (ex.fx?.desc || "");
  if (seen.has(key)) { bump(stats.drop, "duplicate request"); return; }
  seen.add(key);
  const se = schemaErr(ex.commands) || (ex.fx && schemaErr(ex.fx.setup));
  if (se) { bump(stats.drop, "schema"); failures.push(`${t.name}: schema ${se}`); return; }
  const h = heldout(ex.request, ex.fx?.kind, ex.commands);
  if (h.bad) { bump(stats.heldout, h.bad); return; }
  if (strict && h.sim >= 0.6) { bump(stats.heldout, "strict sim>=0.6"); return; }
  const v = await verify(ex);
  if (v) { bump(stats.drop, v.split(":")[0]); failures.push(`${t.name}: ${v} | ${ex.request}`); bump(stats.byTemplate, t.name + " FAIL"); return; }
  const row = { id: `g${String(kept.length + 1).padStart(5, "0")}`, template: t.name, tier: t.tier, cat: t.cat, fixture_kind: ex.fx?.kind || null, state: ex.fx?.desc || "empty model", setup: ex.fx?.setup || [], request: ex.request, commands: ex.commands, check: ex.check, sim: h.sim, sim_eval: h.simId };
  kept.push(row);
  stats.kept++; bump(stats.byTemplate, t.name); bump(stats.tiers, t.tier); bump(stats.cats, t.cat);
  if (h.sim >= 0.6) stats.simHi++;
  closest.push([h.sim, h.simId, ex.request]);
}

const t0 = Date.now();
let lastLog = 0;
while (kept.length < N && stats.tried < N * 4) {
  await Promise.all(Array.from({ length: jobs }, one));
  if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.error(`${kept.length}/${N} kept, ${stats.tried} tried, ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
}

// 5% dev split (synthetic, for early stopping), by a stable hash of the id
const dev = kept.filter((_, i) => i % 20 === 7), train = kept.filter((_, i) => i % 20 !== 7);
writeFileSync(join(out, "train.jsonl"), train.map((x) => JSON.stringify(x)).join("\n") + "\n");
writeFileSync(join(out, "dev.jsonl"), dev.map((x) => JSON.stringify(x)).join("\n") + "\n");
closest.sort((a, b) => b[0] - a[0]);
const cases = Object.fromEntries(readFileSync(join(here, "eval/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((c) => [c.id, c.request]));
const report = {
  seed, n: kept.length, train: train.length, dev: dev.length, seconds: Math.round((Date.now() - t0) / 1000), tried: stats.tried,
  tiers: stats.tiers, cats: stats.cats, dropped: stats.drop, heldout_dropped: stats.heldout, word_cosine_ge_0_6: stats.simHi, strict,
  templates: stats.byTemplate, closest_20: closest.slice(0, 20).map(([s, id, q]) => ({ sim: s, train: q, eval: `${id}: ${cases[id]}` })),
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
writeFileSync(join(out, "failures.txt"), failures.join("\n") + "\n");
const sample = flag("sample");
if (sample) {
  // one or two of every template, for the repo
  const per = {};
  const s = kept.filter((x) => (per[x.template] = (per[x.template] || 0) + 1) <= 2);
  mkdirSync(dirname(sample), { recursive: true });
  writeFileSync(sample, s.map((x) => JSON.stringify(x)).join("\n") + "\n");
}
console.log(JSON.stringify({ ...report, templates: undefined, closest_20: undefined }, null, 1));
