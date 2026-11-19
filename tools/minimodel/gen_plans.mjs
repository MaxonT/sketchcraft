#!/usr/bin/env node
// Route 2 training data: a person's floor plan, said or written room by room -> ONE floorplan_build command.
// Synthetic houses (1-3 floors, 3-12 rooms, realistic room sizes, doors, open plans, windows, stairs) laid out in
// rows from the front, described in varied wording and units (feet, feet-and-inches, meters, centimeters), with the
// gold command in the person's units. Every pair is VERIFIED before it is kept:
//   1. a fresh `sketchcraft mcp` (untrusted agent policy, scratch HOME and document) runs the command and accepts it;
//   2. the reply has the expected floors, rooms (by name, with their areas from the description's numbers) and the
//      expected number of doors, windows, openings and open sides (lib/check.mjs `plan`);
//   3. ONE undo restores the empty model;
//   4. it is held out from the plan eval set (eval/plan_cases.jsonl, which includes the owner's townhouse): no pair
//      has an eval plan's room list or the same description pattern.
//
//   node gen_plans.mjs --n 3000 [--seed 11] [--out DIR] [--jobs 4]       training pairs (+ chat JSONL)
//   node gen_plans.mjs --eval 30 [--seed 90210]                            (re)write the held-out plan eval cases
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "./lib/engine.mjs";
import { gradePlan } from "./lib/check.mjs";
import { chatMessages } from "./lib/spec.mjs";
import { mask, norm } from "./lib/heldout.mjs";
import { makeRng } from "./gen/templates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf("--" + n); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };
const EVAL = join(here, "eval/plan_cases.jsonl");

// ---------- rooms (sizes in feet: width range, depth range) ----------
const TYPES = {
  living: { w: [12, 20], d: [12, 20], say: ["living room", "living room", "lounge", "great room"], hab: 1 },
  kitchen: { w: [9, 14], d: [9, 16], say: ["kitchen"], hab: 1 },
  dining: { w: [9, 14], d: [9, 14], say: ["dining room", "dining"], hab: 1 },
  family: { w: [12, 18], d: [12, 18], say: ["family room", "den"], hab: 1 },
  bedroom: { w: [10, 14], d: [10, 14], say: ["bedroom"], hab: 1, many: 1 },
  primary: { w: [12, 16], d: [12, 16], say: ["primary bedroom", "master bedroom", "main bedroom"], hab: 1 },
  bath: { w: [5, 9], d: [6, 12], say: ["bathroom", "bath"], hab: 1, many: 1 },
  half: { w: [4, 6], d: [5, 10], say: ["half bath", "powder room"] },
  hall: { w: [3.5, 5], d: [8, 24], say: ["hall", "hallway"] },
  entry: { w: [5, 10], d: [6, 14], say: ["entry", "foyer"] },
  laundry: { w: [5, 8], d: [5, 10], say: ["laundry", "laundry room", "utility room"] },
  office: { w: [9, 12], d: [9, 13], say: ["office", "study"], hab: 1 },
  garage: { w: [11, 24], d: [19, 24], say: ["garage"] },
  pantry: { w: [4, 6], d: [4, 8], say: ["pantry"] },
  mudroom: { w: [5, 8], d: [6, 10], say: ["mudroom", "mud room"] },
  loft: { w: [10, 18], d: [10, 18], say: ["loft", "bonus room"], hab: 1 },
  closet: { w: [3, 6], d: [3, 8], say: ["closet", "storage room"] },
  stairs: { w: [3.5, 4.5], d: [11, 16], say: ["stairs", "stairs", "stairwell", "stair hall"] },
};
const GROUND = ["living", "kitchen", "dining", "family", "bedroom", "primary", "bath", "half", "hall", "entry", "laundry", "office", "pantry", "mudroom", "closet"];
const UPPER = ["bedroom", "bedroom", "primary", "bath", "bath", "hall", "office", "loft", "laundry", "closet"];
const SOCIAL = new Set(["living", "kitchen", "dining", "family"]);

// ---------- units ----------
// u: {key, k: meters per unit, grid, minDoor} ; plans are built in feet then converted to the unit's grid
const UNITS = {
  ft: { key: "ft", k: 0.3048, fromFt: (x) => x, grid: 0.5 },
  m: { key: "m", k: 1, fromFt: (x) => Math.round(x * 0.3048 * 10) / 10, grid: 0.1 },
  cm: { key: "cm", k: 0.01, fromFt: (x) => Math.round(x * 0.3048 * 10) * 10, grid: 10 },
};
const T2 = 0.2; // the engine's default wall thickness, meters

function makePlan(r, floorsN, maxRooms) {
  // floor 1: rows (bands) from the front; each row's rooms fill the house width
  const pickType = (pool, d, used) => {
    const ok = pool.filter((t) => d >= TYPES[t].d[0] && d <= TYPES[t].d[1] && (TYPES[t].many || !used.has(t)));
    return ok.length ? r.pick(ok) : null;
  };
  const wOf = (t) => r.step(TYPES[t].w[0], TYPES[t].w[1], r.chance(0.8) ? 1 : 0.5);
  const floors = [];
  const nb = floorsN === 1 ? r.int(1, 3) : r.int(2, 3);
  const used = new Set();
  // front row sets the width
  const depths = [];
  const rows = [];
  const garage = r.chance(floorsN > 1 ? 0.5 : 0.35);
  const stairRow = floorsN > 1 ? r.int(0, nb - 1) : -1;
  for (let b = 0; b < nb; b++) {
    let d = b === 0 && garage ? r.int(20, 24) : r.step(8, 18, 1);
    if (b === stairRow) d = Math.max(d, r.int(11, 14));
    depths.push(d);
  }
  let W = null;
  const perRow = Math.max(1, Math.floor(maxRooms / floorsN / nb));
  for (let b = 0; b < nb; b++) {
    const d = depths[b];
    let row = null;
    for (let tries = 0; tries < 60 && !row; tries++) {
      const k = r.int(1, Math.min(4, perRow + 1));
      const types = [];
      const u2 = new Set(used);
      if (b === 0 && garage) { types.push("garage"); u2.add("garage"); }
      if (b === stairRow) types.splice(r.int(0, types.length), 0, "stairs");
      while (types.length < k + (b === stairRow ? 1 : 0)) { const t = pickType(GROUND, d, u2); if (!t) break; types.push(t); u2.add(t); }
      if (types.length === 0) continue;
      const ws = types.map(wOf);
      if (W == null) { W = ws.reduce((a, x) => a + x, 0); if (W < 16 || W > 60) continue; }
      else {
        const rest = W - ws.slice(0, -1).reduce((a, x) => a + x, 0);
        const t = types[types.length - 1];
        if (rest < TYPES[t].w[0] * 0.8 || rest > TYPES[t].w[1] * 1.3) continue;
        ws[ws.length - 1] = rest;
      }
      row = types.map((t, i) => ({ t, w: ws[i], d }));
      for (const t of types) used.add(t);
    }
    if (!row) return null;
    rows.push(row);
  }
  floors.push(rows);
  // upper floors: same rows and width, stairs in the same place, the rest bedrooms, baths, a hall...
  for (let f = 1; f < floorsN; f++) {
    const up = [];
    const u2 = new Set();
    for (let b = 0; b < nb; b++) {
      const d = depths[b];
      let row = null;
      for (let tries = 0; tries < 60 && !row; tries++) {
        if (b === stairRow) {
          const g = rows[b];
          const si = g.findIndex((x) => x.t === "stairs");
          const left = g.slice(0, si).reduce((a, x) => a + x.w, 0), right = W - left - g[si].w;
          const fill = (span) => {
            if (span === 0) return [];
            const out = [];
            let restW = span;
            while (restW > 0) {
              const t = pickType(UPPER, d, u2) || "closet";
              let w = wOf(t);
              if (restW - w < 3 || w > restW) w = restW;
              if (w > TYPES[t].w[1] * 1.6) return null;
              out.push({ t, w, d }); restW = +(restW - w).toFixed(3); if (!TYPES[t].many) u2.add(t);
            }
            return out;
          };
          const L = fill(left), R = fill(right);
          if (L && R) row = [...L, { ...g[si] }, ...R];
          continue;
        }
        const k = r.int(1, Math.min(4, perRow + 1));
        const types = [];
        const u3 = new Set(u2);
        while (types.length < k) { const t = pickType(UPPER, d, u3); if (!t) break; types.push(t); if (!TYPES[t].many) u3.add(t); }
        if (!types.length) continue;
        const ws = types.map(wOf);
        const rest = W - ws.slice(0, -1).reduce((a, x) => a + x, 0);
        const t = types[types.length - 1];
        if (rest < TYPES[t].w[0] * 0.8 || rest > TYPES[t].w[1] * 1.6) continue;
        ws[ws.length - 1] = rest;
        row = types.map((tt, i) => ({ t: tt, w: ws[i], d }));
        for (const tt of types) if (!TYPES[tt].many) u2.add(tt);
      }
      if (!row) return null;
      up.push(row);
    }
    floors.push(up);
  }
  return { floors, W, depths };
}

// ---------- the plan in a unit, with names, openings and the gold command ----------
function build(r, raw, U) {
  const conv = (ft) => U.fromFt(ft);
  const total = raw.floors.flat(2).length;
  if (total < 3 || total > 12) return null;
  // names: numbered when repeated across the house; stairs keep one name on every floor
  const counts = {};
  for (const x of raw.floors.flat(2)) counts[x.t] = (counts[x.t] || 0) + (x.t === "stairs" ? 0 : 1);
  const said = {};
  for (const t of Object.keys(counts)) said[t] = r.pick(TYPES[t].say);
  const seen = {};
  // positions are converted, not sizes, so rows stay the same width and the stairs line up floor to floor
  const r3 = (v) => +v.toFixed(3);
  const floors = raw.floors.map((rows) => {
    let yFt = 0;
    const rooms = [];
    for (const [bi, row] of rows.entries()) {
      const y0 = conv(yFt), y1 = conv(yFt + row[0].d);
      let xFt = 0;
      for (const [i, q] of row.entries()) {
        const x0 = conv(xFt), x1 = conv(i === row.length - 1 ? raw.W : xFt + q.w);
        if (x1 - x0 <= 0) return null;
        const n = q.t === "stairs" ? 1 : (seen[q.t] = (seen[q.t] || 0) + 1);
        const spoken = said[q.t] + (counts[q.t] > 1 ? ` ${n}` : "");
        const name = spoken.replace(/\b\w/g, (c) => c.toUpperCase());
        rooms.push({ t: q.t, name, spoken, rect: [r3(x0), r3(y0), r3(x1 - x0), r3(y1 - y0)], row: bi, col: i });
        xFt += q.w;
      }
      yFt += row[0].d;
    }
    return { rooms, rows: rows.length, depth: r3(conv(yFt)) };
  });
  if (floors.some((f) => !f)) return null;
  const Wu = conv(raw.W);
  const tU = T2 / U.k;
  const doorU = 0.9 / U.k;
  // shared wall length between two rects (centerlines)
  const shared = (a, b) => {
    const [ax, ay, aw, ad] = a.rect, [bx, by, bw, bd] = b.rect;
    const ov = (l1, h1, l2, h2) => Math.max(0, Math.min(h1, h2) - Math.max(l1, l2));
    if (Math.abs(ax + aw - bx) < 1e-6 || Math.abs(bx + bw - ax) < 1e-6) return ov(ay, ay + ad, by, by + bd);
    if (Math.abs(ay + ad - by) < 1e-6 || Math.abs(by + bd - ay) < 1e-6) return ov(ax, ax + aw, bx, bx + bw);
    return 0;
  };
  const outF = [];
  for (const [fi, fl] of floors.entries()) {
    const R = fl.rooms;
    const ops = [];
    // a tree of connections from the entry (or the stairs upstairs) so every room can be reached
    const startT = fi === 0 ? ["entry", "hall", "living", "family", "kitchen"] : ["stairs", "hall", "loft"];
    let start = R.findIndex((x) => startT.includes(x.t) && x.t !== "garage");
    if (start < 0) start = R.findIndex((x) => x.t !== "garage");
    const reached = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const a = queue.shift();
      for (const b of r.shuffle(R.map((_, i) => i))) {
        if (reached.has(b)) continue;
        const len = shared(R[a], R[b]);
        if (len < doorU + tU + 0.3 / U.k) continue;
        reached.add(b); queue.push(b);
        const both = SOCIAL.has(R[a].t) && SOCIAL.has(R[b].t);
        const stair = R[a].t === "stairs" || R[b].t === "stairs";
        const hallish = ["hall", "entry", "loft"].includes(R[a].t) || ["hall", "entry", "loft"].includes(R[b].t);
        let kind = "door";
        if (both) kind = r.pick(["open", "open", "opening", "door"]);
        else if (stair) kind = r.chance(0.6) ? "open" : "door";
        else if (hallish && (SOCIAL.has(R[a].t) || SOCIAL.has(R[b].t))) kind = r.pick(["open", "opening", "door"]);
        if (R[a].t === "garage" || R[b].t === "garage") kind = "door";
        if (kind === "opening" && len < (1.2 + 0.2 + 0.15) / U.k) kind = "door";
        const o = { kind, between: [R[a].name, R[b].name] };
        if (kind === "door" && r.chance(0.15)) { const w = U.key === "ft" ? r.pick([2.5, 2.67, 3]) : U.key === "m" ? r.pick([0.8, 0.85, 0.9]) : r.pick([80, 90]); if (w + tU < len - 0.15 / U.k) o.width = w; }
        if (kind === "opening" && r.chance(0.4)) { const w = U.key === "ft" ? r.pick([4, 5, 6]) : U.key === "m" ? r.pick([1.2, 1.5, 1.8]) : r.pick([120, 150]); if (w + tU < len - 0.15 / U.k) o.width = w; }
        ops.push(o);
      }
    }
    if (reached.size !== R.length) return null;
    // exterior: front door, garage door, windows
    const ext = (q) => {
      const [x, y, w, d] = q.rect;
      const s = [];
      if (y === 0) s.push(["south", w]);
      if (Math.abs(y + d - fl.depth) < 1e-6) s.push(["north", w]);
      if (x === 0) s.push(["west", d]);
      if (Math.abs(x + w - Wu) < 1e-6) s.push(["east", d]);
      return s;
    };
    if (fi === 0) {
      const front = R.filter((q) => q.rect[1] === 0 && q.rect[2] >= 1.3 / U.k);
      const best = front.filter((q) => ["entry", "hall", "living"].includes(q.t));
      const ok = front.filter((q) => ["mudroom", "family", "kitchen", "dining", "office"].includes(q.t));
      const fd = best.length ? r.pick(best) : ok.length ? r.pick(ok) : null;
      if (fd) ops.push({ kind: "door", between: [fd.name, "outside"], side: "south", front: true });
      const g = R.find((q) => q.t === "garage");
      if (g) {
        const gw = U.key === "ft" ? r.pick([8, 9, 16].filter((v) => v + 2 < g.rect[2])) : U.key === "m" ? r.pick([2.4, 2.7, 4.8].filter((v) => v + 0.6 < g.rect[2])) : r.pick([240, 270].filter((v) => v + 60 < g.rect[2]));
        if (gw) ops.push({ kind: "door", between: [g.name, "outside"], side: "south", width: gw, height: U.key === "ft" ? 7 : U.key === "m" ? 2.1 : 210, garage: true });
      }
      if (!fd && !g) return null;
    }
    for (const q of R) {
      if (!TYPES[q.t].hab) continue;
      const sides = r.shuffle(ext(q));
      const nWin = !sides.length ? 0 : r.chance(0.8) ? (r.chance(0.25) && sides.length > 1 ? 2 : 1) : 0;
      for (const [side, len] of sides.slice(0, nWin)) {
        if (ops.some((o) => o.between[0] === q.name && o.between[1] === "outside" && o.side === side)) continue;
        const o = { kind: "window", between: [q.name, "outside"], side };
        if (r.chance(0.4)) { const w = U.key === "ft" ? r.pick([2, 3, 4, 5, 6]) : U.key === "m" ? r.pick([0.6, 0.9, 1.2, 1.5, 1.8]) : r.pick([60, 90, 120, 150]); if (w + tU < len - 0.15 / U.k) o.width = w; }
        if ((1.2 + 0.15) / U.k + tU >= len && !o.width) continue;
        ops.push(o);
      }
    }
    const stairs = fi < floors.length - 1 && R.some((q) => q.t === "stairs") ? [{ room: R.find((q) => q.t === "stairs").name }] : [];
    outF.push({ rooms: R, openings: ops, stairs });
  }
  const wallH = r.chance(0.25) ? (U.key === "ft" ? r.pick([8, 9, 10]) : U.key === "m" ? r.pick([2.4, 2.6, 2.7, 3]) : r.pick([240, 260, 270])) : null;
  const cmd = { cmd: "floorplan_build", units: U.key, ...(wallH ? { wall_height: wallH } : {}), floors: outF.map((f) => ({
    rooms: f.rooms.map((q) => ({ name: q.name, rect: q.rect })),
    ...(f.openings.length ? { openings: f.openings.map(({ front, garage, ...o }) => o) } : {}),
    ...(f.stairs.length ? { stairs: f.stairs } : {}),
  })) };
  const check = { plan: { floors: outF.map((f) => ({ rooms: f.rooms.map((q) => [q.name, +(q.rect[2] * q.rect[3] * U.k * U.k).toFixed(3)]), openings: ["door", "window", "opening", "open"].reduce((o, k) => ({ ...o, [k]: f.openings.filter((x) => x.kind === k).length }), {}) })) } };
  return { cmd, check, floors: outF, U, wallH, Wu };
}

// ---------- words ----------
function num(r, v, U) {
  if (U.key !== "ft") return String(+v.toFixed(2));
  const whole = Math.floor(v), frac = +(v - whole).toFixed(3);
  if (frac === 0) return String(whole);
  const inch = Math.round(frac * 12);
  return r.pick([`${whole}'${inch}"`, `${whole} ft ${inch} in`, String(+v.toFixed(2))]);
}
const feetMark = (t) => (/ft|in|['"]/.test(t) ? t : `${t}'`);
function describe(r, P) {
  const { U } = P;
  const unitWord = U.key === "ft" ? r.pick(["ft", "feet", "'"]) : U.key === "m" ? r.pick(["m", "meters", "metres", "m"]) : "cm";
  const globalUnit = r.chance(0.5);
  const x = r.pick(["x", "x", "by", "×", " x "]);
  const dim = (w, d) => {
    const a = num(r, w, U), b = num(r, d, U);
    const sep = x === "by" ? " by " : x === " x " ? " x " : x;
    if (globalUnit) return `${a}${sep}${b}`;
    if (unitWord === "'") return `${feetMark(a)}${sep}${feetMark(b)}`;
    return `${a}${sep}${b} ${unitWord}`;
  };
  const len = (v) => { const t = num(r, v, U); return globalUnit ? t : unitWord === "'" ? feetMark(t) : /ft|in|['"]/.test(t) ? t : `${t} ${unitWord}`; };
  const nf = P.floors.length;
  const style = r.pick(["list", "prose", "compact"]);
  const floorName = (i) => (nf === 1 ? null : i === 0 ? r.pick(["Ground floor", "Main floor", "First floor", "Downstairs"]) : i === 1 ? r.pick(["Upstairs", "Second floor", "Upper floor"]) : r.pick(["Third floor", "Top floor"]));
  const lines = [];
  const kindHouse = nf === 1 ? r.pick(["A one-story house", "Single-story house", "A small house", "Ranch house, one floor", "A cabin"]) : nf === 2 ? r.pick(["Two-story house", "A 2-story house", "Two floor house", "A two-story home"]) : r.pick(["Three-story house", "A 3-story townhouse", "Three floors"]);
  const unitNote = globalUnit ? (U.key === "ft" ? r.pick(["sizes in feet", "all in feet", "dimensions in ft"]) : U.key === "m" ? r.pick(["sizes in meters", "all in metres", "dimensions in m"]) : "sizes in cm") : null;
  const wxd = r.chance(0.5) ? r.pick([" (width x depth)", ", width by depth", " (w x d)"]) : "";
  lines.push(`${kindHouse}${unitNote ? ", " + unitNote : ""}${wxd}${P.wallH ? `, ${len(P.wallH)} ${r.pick(["walls", "ceilings", "wall height"])}` : ""}.`);
  const rowName = (i, n) => (i === 0 ? r.pick(["Front row", "Along the front", "At the front", "Front"]) : i === n - 1 ? r.pick(["Back row", "At the back", "Along the back", "Rear"]) : r.pick(["Middle row", "Next row back", "Behind that", "Then"]));
  for (const [fi, f] of P.floors.entries()) {
    const fname = floorName(fi);
    const rowsN = Math.max(...f.rooms.map((q) => q.row)) + 1;
    const ltr = r.pick([" (left to right)", ", left to right", ""]);
    const rowText = [];
    for (let i = 0; i < rowsN; i++) {
      const rr = f.rooms.filter((q) => q.row === i);
      const items = rr.map((q) => style === "prose" ? `${r.chance(0.5) ? "a " : "the "}${q.spoken} (${dim(q.rect[2], q.rect[3])})` : `${q.spoken} ${dim(q.rect[2], q.rect[3])}`);
      const joined = style === "prose" ? (items.length > 1 ? items.slice(0, -1).join(", ") + " and " + items.at(-1) : items[0]) : items.join(", ");
      rowText.push(style === "prose" ? `${rowName(i, rowsN)}${ltr}: ${joined}.` : `${rowName(i, rowsN)}${ltr}: ${joined}`);
    }
    // connections
    const conn = [];
    for (const o of f.openings) {
      const [a, b] = o.between.map((nm) => (nm === "outside" ? "outside" : f.rooms.find((q) => q.name === nm).spoken));
      const w = o.width ? `${len(o.width)} ` : "";
      if (o.kind === "window") continue;
      if (b === "outside") {
        if (o.height) conn.push(r.pick([`a ${w}garage door`, `${w}overhead door on the ${a}`, `the ${a} gets a ${w}garage door`]));
        else conn.push(r.pick([`front door into the ${a}`, `the front door opens into the ${a}`, `entrance through the ${a}`, `${w}front door in the ${a}`]));
      } else if (o.kind === "open") conn.push(r.pick([`${a} open to ${b}`, `the ${a} is open to the ${b}`, `no wall between ${a} and ${b}`, `${a} and ${b} open plan`]));
      else if (o.kind === "opening") conn.push(r.pick([`a ${w}wide opening between ${a} and ${b}`, `${w}archway from ${a} to ${b}`, `cased ${w}opening ${a}-${b}`]));
      else conn.push(r.pick([`${w}door ${a} to ${b}`, `${a}-${b} ${w}door`, `a ${w}door between the ${a} and the ${b}`, `door from ${a} into ${b}`].map((s) => s.replace("  ", " "))));
    }
    const sideWord = (s) => r.pick({ south: ["front", "front", "south"], north: ["back", "rear", "north"], west: ["left", "west", "left side"], east: ["right", "east", "right side"] }[s]);
    const wins = f.openings.filter((o) => o.kind === "window").map((o) => {
      const q = f.rooms.find((z) => z.name === o.between[0]).spoken;
      const w = o.width ? `${len(o.width)} ` : "";
      return r.pick([`${q} ${sideWord(o.side)}${o.width ? ` (${len(o.width)})` : ""}`, `a ${w}window on the ${sideWord(o.side)} of the ${q}`, `${w}window in the ${q}, ${sideWord(o.side)} wall`]);
    });
    const sn = f.stairs.length ? f.rooms.find((q) => q.name === f.stairs[0].room).spoken : null;
    const st = !sn ? "" : sn === "stairs" ? r.pick(["The stairs go up to the next floor.", "Stairs lead up.", "The stairs climb to the floor above."]) : r.pick([`Stairs go up in the ${sn}.`, `The stair climbs in the ${sn}.`, `Stairs up in the ${sn}.`]);
    const parts = [];
    if (fname) parts.push(`${fname}${style === "list" ? ":" : " -"}`);
    if (style === "list") {
      parts.push(...rowText.map((t) => `- ${t}`));
      if (conn.length) parts.push(`- ${r.pick(["Doors", "Connections", "Openings"])}: ${conn.join("; ")}`);
      if (wins.length) parts.push(`- Windows: ${wins.join("; ")}`);
      if (st) parts.push(`- ${st}`);
      lines.push(parts.join("\n"));
    } else if (style === "prose") {
      parts.push(rowText.join(" "));
      if (conn.length) parts.push(`${r.pick(["Doors:", "Connections:", "Getting around:"])} ${conn.join(", ")}.`);
      if (wins.length) parts.push(`${r.pick(["Windows:", "Windows go in:", "Windows -"])} ${wins.join(", ")}.`);
      if (st) parts.push(st);
      lines.push(parts.join(" "));
    } else {
      parts.push(rowText.join(". ") + ".");
      if (conn.length) parts.push(`Doors: ${conn.join(", ")}.`);
      if (wins.length) parts.push(`Windows: ${wins.join(", ")}.`);
      if (st) parts.push(st);
      lines.push(parts.join(" "));
    }
  }
  let text = lines.join(style === "list" ? "\n" : " ");
  if (r.chance(0.15)) text = text.toLowerCase();
  if (r.chance(0.15)) text = r.pick(["Can you build this: ", "Make this floor plan. ", "Here's the plan: ", "Build me a house. "]) + text;
  return text;
}

// ---------- questions about a built plan's rooms (room_info) ----------
// Training phrasings; EVAL_ASK phrasings are only ever in the eval set.
const ASK = ["how big is the {r}", "how big is the {r}?", "what's the area of the {r}", "what's the area of {r}", "sq ft of the {r}", "square feet in the {r}?",
  "how many square feet is the {r}", "how many square meters is the {r}", "what size is the {r}", "{r} dimensions?", "how large is the {r}",
  "what's the floor area of the {r}", "perimeter of the {r}", "how much floor space does the {r} have", "area of {r} please", "is the {r} big? how many sq ft",
  "what are the measurements of the {r}", "the {r}, how many m2", "give me the {r} size", "how wide is the {r}"];
export const EVAL_ASK = ["what is the square footage of the {r}", "how many sq m is the {r}?", "tell me the size of {r}", "whats the {r} square footage"];
const refOf = (r, name) => {
  const n = name.toLowerCase();
  const alt = [];
  if (/^(primary|master|main) bedroom/.test(n)) alt.push("master", "master bedroom", "primary bedroom", "main bedroom", "primary");
  const m = /^(bedroom|bathroom|bath) (\d)$/.exec(n);
  if (m) alt.push(m[1] === "bedroom" ? `bed ${m[2]}` : `bath ${m[2]}`);
  return r.chance(0.5) && alt.length ? r.pick(alt) : n;
};
const stateOfPlan = (cmd) => `a house built with floorplan_build; rooms: ${cmd.floors.map((f, i) => f.rooms.map((q) => q.name).join(", ") + (cmd.floors.length > 1 ? ` (floor ${i + 1})` : "")).join("; ")}`;
function question(r, cmd, phrasings) {
  const stair = new Set(cmd.floors.flatMap((f) => (f.stairs || []).map((x) => x.room)));
  const rooms = cmd.floors.flatMap((f) => f.rooms).filter((q) => !stair.has(q.name));
  if (!rooms.length) return null;
  const q = r.pick(rooms);
  const ref = refOf(r, q.name);
  let request = r.pick(phrasings).replace("{r}", ref);
  if (r.chance(0.2)) request = r.pick(["um ", "ok ", "hey ", "quick question, "]) + request;
  return { request, state: stateOfPlan(cmd), setup: [cmd], commands: [{ cmd: "room_info", name: q.name }], check: { readonly: true, room: q.name }, ref };
}
async function verifyQ(ex) {
  const s = await new Session().init();
  try {
    const f = await s.run(ex.setup);
    if (!f.ok) return `setup: ${f.error}`;
    const before = await s.inspect();
    const run = await s.run(ex.commands);
    if (!run.ok) return `engine: ${run.error}`;
    const got = run.replies[0];
    if (got.room !== ex.check.room || typeof got.area_m2 !== "number") return `check: room_info answered ${got.room}`;
    // the person's own words must find the same room too (the engine's loose matcher, e.g. "master" -> Primary Bedroom)
    if (ex.ref) {
      const loose = await s.run([{ cmd: "room_info", name: ex.ref }]);
      if (!loose.ok || loose.replies[0].room !== ex.check.room) return `check: room_info "${ex.ref}" found ${loose.replies[0]?.room || loose.error}`;
    }
    const after = await s.inspect();
    if (JSON.stringify([before.info.faces, before.info.bounds]) !== JSON.stringify([after.info.faces, after.info.bounds])) return "check: a question changed the model";
    return null;
  } finally { s.close(); }
}

// ---------- verification ----------
async function verify(ex) {
  const s = await new Session().init();
  try {
    const before = await s.inspect();
    const run = await s.run([ex.cmd]);
    if (!run.ok) return `engine: ${run.error || run.stopped}`;
    const errs = gradePlan(ex.check.plan, run.replies);
    if (errs.length) return `check: ${errs[0]}`;
    const u = await s.run([{ cmd: "undo" }]);
    const after = await s.inspect();
    if (!u.ok || after.info.faces !== before.info.faces || (after.info.groups || []).length) return "one-undo: a single undo did not restore the model";
    return null;
  } finally { s.close(); }
}

const sigOf = (cmd) => cmd.floors.map((f) => f.rooms.map((q) => `${norm(q.name)}:${(q.rect ? q.rect.slice(2) : [q.polygon.length]).map((v) => +(+v * ({ ft: 0.3048, m: 1, cm: 0.01 }[cmd.units] || 1)).toFixed(1)).join("x")}`).sort().join(",")).join("|");

function generate(r) {
  const nf = r.pick([1, 1, 1, 2, 2, 2, 3]);
  const maxRooms = r.int(Math.max(3, nf * 2), 12);
  const raw = makePlan(r, nf, maxRooms);
  if (!raw) return null;
  const U = UNITS[r.pick(["ft", "ft", "ft", "m", "m", "cm"])];
  const P = build(r, raw, U);
  if (!P) return null;
  return { request: describe(r, P), cmd: P.cmd, check: P.check, floors: nf, rooms: P.cmd.floors.reduce((a, f) => a + f.rooms.length, 0), units: U.key };
}

async function pool(n, jobs, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: jobs }, async () => { while (i < n) { const k = i++; await fn(k); } }));
}

const jobs = Number(flag("jobs", 4));
if (flag("eval")) {
  const n = Number(flag("eval")), r = makeRng(Number(flag("seed", 90210)));
  const out = [];
  while (out.length < n) {
    const ex = generate(r);
    if (!ex) continue;
    const v = await verify(ex);
    if (v) { console.error("eval candidate dropped:", v); if (/overlap/.test(v)) console.error(JSON.stringify(ex.cmd.floors.map((f) => f.rooms))); continue; }
    out.push({ id: `p${String(out.length + 1).padStart(3, "0")}`, tier: "plan", cat: "plan", request: ex.request, fixture: null, gold: [ex.cmd], check: ex.check });
  }
  // the owner's townhouses (hand-written descriptions of the two drawings; gold = fixtures/*.plan.json)
  const houses = {};
  for (const [key, id] of [["townhouse", "p_townhouse"], ["townhouse-2br", "p_townhouse_2br"]]) {
    const cmd = { cmd: "floorplan_build", ...JSON.parse(readFileSync(join(here, `fixtures/${key}.plan.json`), "utf8")) };
    const s = await new Session().init();
    const run = await s.run([cmd]);
    s.close();
    if (!run.ok) throw new Error(`${key} does not build: ${run.error}`);
    const check = { plan: { floors: run.replies[0].floors.map((f) => ({ rooms: f.rooms.map((q) => [q.name, q.gross_area]), openings: ["door", "window", "opening", "open"].reduce((o, k) => ({ ...o, [k]: f.openings.filter((x) => x.kind === k).length }), {}) })) } };
    out.push({ id, tier: "plan", cat: "plan", request: readFileSync(join(here, `fixtures/${key}.request.txt`), "utf8").trim(), fixture: null, gold: [cmd], check });
    houses[key] = cmd;
  }
  // room questions: on held-out plans (eval-only phrasings) and on both townhouses
  const plans = out.filter((c) => c.cat === "plan" && !c.id.startsWith("p_townhouse"));
  for (let i = 0; i < 16; i++) {
    const ex = question(r, plans[i % plans.length].gold[0], EVAL_ASK);
    if (!ex || (await verifyQ(ex))) continue;
    out.push({ id: `q${String(i + 1).padStart(3, "0")}`, tier: "plan", cat: "room_q", request: ex.request, fixture: null, setup: ex.setup, state: ex.state, gold: ex.commands, check: ex.check });
  }
  const asks = [
    ["q_townhouse_master", "townhouse", "what is the square footage of the master", "Primary Bedroom", 169, "master"],
    ["q_townhouse_bed3", "townhouse", "how big is bed 3", "Bed 3", 120, "bed 3"],
    ["q_townhouse_loft", "townhouse", "what's the loft's area in square feet?", "Loft", null, "loft"],
    ["q_townhouse_kitchen", "townhouse", "how many square feet is the kitchen", "Kitchen", 150, "kitchen"],
    ["q_2br_master", "townhouse-2br", "what is the square footage of the master", "Primary Bedroom", 169, "master"],
    ["q_2br_bedroom2", "townhouse-2br", "how big is bedroom 2?", "Bed 2", 264, "bedroom 2"],
    ["q_2br_owners", "townhouse-2br", "what's the area of the owner's bedroom", "Primary Bedroom", 169, "owner's bedroom"],
    ["q_2br_living", "townhouse-2br", "sq ft of the living room upstairs or downstairs, whichever has one", "Living / Dining", 180, "living room"],
  ];
  for (const [id, key, request, room, ft2, ref] of asks) {
    const ex = { ref, request, state: stateOfPlan(houses[key]), setup: [houses[key]], commands: [{ cmd: "room_info", name: room }], check: { readonly: true, room, ...(ft2 ? { area_ft2: ft2 } : {}) } };
    const v = await verifyQ(ex);
    if (v) throw new Error(`${id}: ${v}`);
    out.push({ id, tier: "plan", cat: "room_q", request, fixture: null, setup: ex.setup, state: ex.state, gold: ex.commands, check: ex.check });
  }
  writeFileSync(EVAL, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`${out.length} plan eval cases -> ${EVAL}`);
  process.exit(0);
}

// training
const N = Number(flag("n", 3000)), seed = Number(flag("seed", 11));
const out = flag("out", "/private/tmp/claude-501/minimodel-data/v2-plans");
mkdirSync(out, { recursive: true });
if (!existsSync(EVAL)) throw new Error("write the eval set first: node gen_plans.mjs --eval 30");
const evalCases = readFileSync(EVAL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const evalSigs = new Set(evalCases.filter((c) => c.cat === "plan").map((c) => sigOf(c.gold[0])));
const evalMasks = new Set(evalCases.filter((c) => c.cat === "plan").map((c) => mask(c.request)));
const r = makeRng(seed);
const stats = { tried: 0, kept: 0, drop: {}, floors: {}, units: {}, rooms: {} };
const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
const kept = [], failures = [], seen = new Set();
const t0 = Date.now();
let last = 0;
while (kept.length < N && stats.tried < N * 6) {
  const batch = [];
  for (let j = 0; j < jobs * 4; j++) {
    stats.tried++;
    const ex = generate(r);
    if (!ex) { bump(stats.drop, "layout"); continue; }
    const sg = sigOf(ex.cmd);
    if (evalSigs.has(sg)) { bump(stats.drop, "heldout: eval plan"); continue; }
    if (evalMasks.has(mask(ex.request))) { bump(stats.drop, "heldout: eval pattern"); continue; }
    if (seen.has(sg + norm(ex.request))) { bump(stats.drop, "duplicate"); continue; }
    seen.add(sg + norm(ex.request));
    batch.push(ex);
  }
  await pool(batch.length, jobs, async (k) => {
    const ex = batch[k];
    if (kept.length >= N) return;
    const v = await verify(ex);
    if (v) { bump(stats.drop, v.split(":")[0]); failures.push(`${v} | ${ex.request.slice(0, 160)}${/bug/.test(v) ? " | " + JSON.stringify(ex.cmd) : ""}`); return; }
    kept.push({ id: `pl${String(kept.length + 1).padStart(5, "0")}`, template: "plan", tier: "plan", cat: "plan", fixture_kind: null, state: "empty model", setup: [], request: ex.request, commands: [ex.cmd], check: ex.check, floors: ex.floors, rooms: ex.rooms, units: ex.units });
    bump(stats.floors, ex.floors); bump(stats.units, ex.units); bump(stats.rooms, ex.rooms);
  });
  if (Date.now() - last > 15000) { last = Date.now(); console.error(`${kept.length}/${N} kept, ${stats.tried} tried, ${((Date.now() - t0) / 1000).toFixed(0)} s`); }
}
stats.kept = kept.length;
// room questions on some of the kept training plans (never an eval plan: those were held out above)
const Q = Number(flag("questions", 400));
const qs = [];
const evalReqs = new Set(evalCases.filter((c) => c.cat === "room_q").map((c) => norm(c.request)));
let qi = 0;
while (qs.length < Q && qi < Q * 3) {
  const batch = [];
  for (let j = 0; j < jobs * 4 && qs.length + batch.length < Q; j++, qi++) {
    const ex = question(r, kept[(qi * 7) % kept.length].commands[0], ASK);
    if (ex && !evalReqs.has(norm(ex.request))) batch.push(ex);
  }
  await pool(batch.length, jobs, async (k) => {
    const ex = batch[k];
    const v = await verifyQ(ex);
    if (v) { bump(stats.drop, "question " + v.split(":")[0]); failures.push(`${v} | ${ex.request}`); return; }
    qs.push({ id: `rq${String(qs.length + 1).padStart(5, "0")}`, template: "room_q", tier: "plan", cat: "room_q", fixture_kind: "plan", state: ex.state, setup: ex.setup, request: ex.request, commands: ex.commands, check: ex.check });
  });
}
stats.questions = qs.length;
kept.push(...qs);
const dev = kept.filter((_, i) => i % 20 === 7), train = kept.filter((_, i) => i % 20 !== 7);
const w = (f, rows) => writeFileSync(join(out, f), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
w("train.jsonl", train); w("dev.jsonl", dev);
w("train.chat.jsonl", train.map((x) => ({ id: x.id, messages: chatMessages(x.state, x.request, x.commands) })));
w("dev.chat.jsonl", dev.map((x) => ({ id: x.id, messages: chatMessages(x.state, x.request, x.commands) })));
writeFileSync(join(out, "failures.txt"), failures.join("\n") + "\n");
const report = { seed, n: kept.length, train: train.length, dev: dev.length, seconds: Math.round((Date.now() - t0) / 1000), ...stats };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
const sample = flag("sample");
if (sample) writeFileSync(sample, kept.slice(0, 12).map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(JSON.stringify(report, null, 1));
