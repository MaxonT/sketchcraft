//! `floorplan_build`: a whole house from a compact plan (rooms, doors, windows, floors), deterministically.
//!
//! The plan is what a person (or SketchCraftAI's small model) writes down: each room a rectangle or an
//! orthogonal outline on the WALL CENTERLINES, and each opening as the two rooms it joins ("outside" for an
//! exterior wall). The expander:
//!   1. checks the plan and says exactly what is wrong (the repair loop feeds the message back);
//!   2. merges every room edge on the same line into one wall run, so a wall two rooms share is built once;
//!   3. unions the runs (thickness `wall_thickness`) into one clean footprint per floor, with the rooms as holes,
//!      and pulls it up `wall_height`;
//!   4. cuts each door, window and opening through the wall the two rooms share (doors and openings reach the
//!      floor), with reveals;
//!   4b. leaves the wall out entirely where an opening is kind "open" (open-plan rooms);
//!   5. puts a floor face in each room (unless "floor": false, e.g. a stairwell), in a group named after the room (tag "Rooms"); walls are tagged "Walls".
//! Everything sits in one group per floor inside one group for the plan, and the command is one undo step.
//! No AI here: the same plan always builds the same model.

use crate::model::{Id, Model};
use anyhow::{anyhow, bail, Result};
use glam::{DVec2, DVec3};
use serde_json::{json, Value};
use std::collections::HashMap;

const MAX_FLOORS: usize = 8;
const MAX_ROOMS: usize = 80;
const MAX_OPENINGS: usize = 300;
const MAX_POINTS: usize = 64;
const MAX_SIZE: f64 = 500.0;
const EPS: f64 = 1e-6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Door,
    Window,
    Opening,
    /// no wall at all on the shared edge (an open-plan kitchen and living room)
    Open,
}

pub struct Room {
    pub name: String,
    /// counter-clockwise, orthogonal, on the wall centerlines (plan coordinates, origin applied)
    pub ring: Vec<DVec2>,
    /// false: no floor face (a stairwell on the floor above)
    pub floor: bool,
}

pub struct Opening {
    pub kind: Kind,
    pub a: usize,
    pub b: Option<usize>,
    pub side: Option<DVec2>,
    pub at: Option<DVec2>,
    pub width: f64,
    pub height: f64,
    pub sill: f64,
    pub path: String,
}

pub struct Stair {
    pub at: DVec2,
    pub direction: f64,
    pub width: f64,
    pub rise: Option<f64>,
}

pub struct Floor {
    pub level: Value,
    pub elevation: f64,
    pub height: f64,
    pub rooms: Vec<Room>,
    pub openings: Vec<Opening>,
    pub stairs: Vec<Stair>,
}

pub struct Plan {
    pub name: String,
    pub thickness: f64,
    pub floors: Vec<Floor>,
}

// ----- reading the plan (forgiving, with clear errors) ------------------------------------------------------------

fn num(v: &Value, path: &str) -> Result<f64> {
    let x = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_end_matches('m').trim().parse::<f64>().ok(),
        _ => None,
    };
    match x {
        Some(x) if x.is_finite() && x.abs() <= MAX_SIZE * 10.0 => Ok((x * 1000.0).round() / 1000.0),
        Some(_) => bail!("{path}: number out of range"),
        None => bail!("{path}: expected a number in meters, got {v}"),
    }
}

fn opt_num(o: &Value, key: &str, path: &str) -> Result<Option<f64>> {
    match o.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => num(v, &format!("{path}.{key}")).map(Some),
    }
}

fn xy(v: &Value, path: &str) -> Result<DVec2> {
    let a = v.as_array().filter(|a| a.len() == 2 || a.len() == 3).ok_or_else(|| anyhow!("{path}: expected [x, y] in meters, got {v}"))?;
    Ok(DVec2::new(num(&a[0], path)?, num(&a[1], path)?))
}

fn side(s: &str, path: &str) -> Result<DVec2> {
    Ok(match s.trim().to_ascii_lowercase().as_str() {
        "n" | "north" | "back" | "rear" | "top" => DVec2::Y,
        "s" | "south" | "front" | "bottom" => -DVec2::Y,
        "e" | "east" | "right" => DVec2::X,
        "w" | "west" | "left" => -DVec2::X,
        other => bail!("{path}: side must be north, south, east or west (front = south), got \"{other}\""),
    })
}

fn signed_area(r: &[DVec2]) -> f64 {
    (0..r.len()).map(|i| r[i].perp_dot(r[(i + 1) % r.len()])).sum::<f64>() / 2.0
}

fn room_ring(o: &Value, origin: DVec2, path: &str) -> Result<Vec<DVec2>> {
    let mut ring: Vec<DVec2> = if let Some(r) = o.get("rect") {
        let a = r.as_array().filter(|a| a.len() == 4).ok_or_else(|| anyhow!("{path}.rect: expected [x, y, width, depth] in meters, got {r}"))?;
        let (x, y, mut w, mut d) = (num(&a[0], path)?, num(&a[1], path)?, num(&a[2], path)?, num(&a[3], path)?);
        let (mut x, mut y) = (x, y);
        if w < 0.0 {
            x += w;
            w = -w;
        }
        if d < 0.0 {
            y += d;
            d = -d;
        }
        if w < 0.5 || d < 0.5 {
            bail!("{path}.rect: a room must be at least 0.5 m each way (got {w} x {d})");
        }
        vec![DVec2::new(x, y), DVec2::new(x + w, y), DVec2::new(x + w, y + d), DVec2::new(x, y + d)]
    } else if let Some(p) = o.get("polygon") {
        let a = p.as_array().ok_or_else(|| anyhow!("{path}.polygon: expected a list of [x, y] corners"))?;
        if a.len() < 4 || a.len() > MAX_POINTS {
            bail!("{path}.polygon: needs 4 to {MAX_POINTS} corners, got {}", a.len());
        }
        a.iter().enumerate().map(|(i, v)| xy(v, &format!("{path}.polygon[{i}]"))).collect::<Result<_>>()?
    } else {
        bail!("{path}: a room needs \"rect\": [x, y, width, depth] or \"polygon\": [[x, y], ...]");
    };
    for p in &mut ring {
        *p += origin;
    }
    // drop repeated and in-line corners
    ring.dedup_by(|a, b| a.distance(*b) < EPS);
    if ring.len() > 1 && ring[0].distance(*ring.last().unwrap()) < EPS {
        ring.pop();
    }
    let mut i = 0;
    while ring.len() > 2 && i < ring.len() {
        let n = ring.len();
        let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
        if (b - a).perp_dot(c - b).abs() < EPS {
            ring.remove(i);
        } else {
            i += 1;
        }
    }
    if ring.len() < 4 {
        bail!("{path}: the outline has fewer than 4 corners");
    }
    for i in 0..ring.len() {
        let d = ring[(i + 1) % ring.len()] - ring[i];
        if d.x.abs() > EPS && d.y.abs() > EPS {
            bail!("{path}: room walls must run along x or y (edge {} to {} is diagonal)", fmt2(ring[i]), fmt2(ring[(i + 1) % ring.len()]));
        }
    }
    let a = signed_area(&ring);
    if a.abs() < 0.25 {
        bail!("{path}: the room is too small ({:.2} m²)", a.abs());
    }
    if a < 0.0 {
        ring.reverse();
    }
    if ring.iter().any(|p| p.x.abs() > MAX_SIZE || p.y.abs() > MAX_SIZE) {
        bail!("{path}: rooms must lie within {MAX_SIZE} m of the origin");
    }
    Ok(ring)
}

fn fmt2(p: DVec2) -> String {
    format!("[{}, {}]", (p.x * 1000.0).round() / 1000.0, (p.y * 1000.0).round() / 1000.0)
}

fn find_room(rooms: &[Room], name: &str, path: &str) -> Result<usize> {
    let k = name.trim().to_lowercase();
    let hits: Vec<usize> = rooms.iter().enumerate().filter(|(_, r)| r.name.to_lowercase() == k).map(|(i, _)| i).collect();
    match hits.len() {
        1 => Ok(hits[0]),
        0 => bail!("{path}: no room named \"{name}\" on this floor (rooms: {})", rooms.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")),
        _ => bail!("{path}: {} rooms are named \"{name}\" on this floor; give them different names", hits.len()),
    }
}

/// Read and check a plan. `v` is the whole command object.
pub fn parse(v: &Value) -> Result<Plan> {
    let origin = match v.get("origin") {
        None | Some(Value::Null) => DVec2::ZERO,
        Some(o) => xy(o, "origin")?,
    };
    let base_z = v.get("origin").and_then(|o| o.as_array()).and_then(|a| a.get(2)).map(|z| num(z, "origin")).transpose()?.unwrap_or(0.0);
    let height = opt_num(v, "wall_height", "plan")?.unwrap_or(2.7);
    let thickness = opt_num(v, "wall_thickness", "plan")?.unwrap_or(0.2);
    if !(1.5..=20.0).contains(&height) {
        bail!("wall_height must be between 1.5 and 20 m (got {height})");
    }
    if !(0.05..=1.0).contains(&thickness) {
        bail!("wall_thickness must be between 0.05 and 1 m (got {thickness})");
    }
    let name = v.get("name").and_then(|n| n.as_str()).map(|s| s.chars().take(64).collect()).unwrap_or_else(|| "Floor plan".to_string());
    let floors_v = v.get("floors").and_then(|f| f.as_array()).ok_or_else(|| anyhow!("plan: \"floors\" must be a list of floors, each {{level, rooms:[...], openings:[...]}}"))?;
    if floors_v.is_empty() || floors_v.len() > MAX_FLOORS {
        bail!("plan: needs 1 to {MAX_FLOORS} floors, got {}", floors_v.len());
    }
    let mut floors = Vec::new();
    let mut next_z = base_z;
    for (fi, f) in floors_v.iter().enumerate() {
        let fp = format!("floors[{fi}]");
        let h = opt_num(f, "wall_height", &fp)?.unwrap_or(height);
        if !(1.5..=20.0).contains(&h) {
            bail!("{fp}.wall_height must be between 1.5 and 20 m (got {h})");
        }
        let elevation = opt_num(f, "elevation", &fp)?.map(|e| e + base_z).unwrap_or(next_z);
        next_z = elevation + h;
        let rooms_v = f.get("rooms").and_then(|r| r.as_array()).ok_or_else(|| anyhow!("{fp}: \"rooms\" must be a list of {{name, rect:[x, y, width, depth]}}"))?;
        if rooms_v.is_empty() || rooms_v.len() > MAX_ROOMS {
            bail!("{fp}: needs 1 to {MAX_ROOMS} rooms, got {}", rooms_v.len());
        }
        let mut rooms = Vec::new();
        for (ri, r) in rooms_v.iter().enumerate() {
            let rp = format!("{fp}.rooms[{ri}]");
            let name = r.get("name").and_then(|n| n.as_str()).map(|s| s.trim().chars().take(40).collect::<String>()).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("Room {}", ri + 1));
            if name.eq_ignore_ascii_case("outside") {
                bail!("{rp}: \"outside\" is reserved for exterior walls; rename the room");
            }
            rooms.push(Room { name, ring: room_ring(r, origin, &rp)?, floor: r.get("floor").and_then(|f| f.as_bool()).unwrap_or(true) });
        }
        check_overlaps(&rooms, &fp)?;
        let mut openings = Vec::new();
        let ops = match f.get("openings") {
            None | Some(Value::Null) => vec![],
            Some(o) => o.as_array().cloned().ok_or_else(|| anyhow!("{fp}.openings: expected a list"))?,
        };
        if ops.len() > MAX_OPENINGS {
            bail!("{fp}: at most {MAX_OPENINGS} openings per floor");
        }
        for (oi, o) in ops.iter().enumerate() {
            let op = format!("{fp}.openings[{oi}]");
            let kind = match o.get("kind").and_then(|k| k.as_str()).unwrap_or("door").trim().to_ascii_lowercase().as_str() {
                "door" | "doorway" => Kind::Door,
                "window" => Kind::Window,
                "opening" | "archway" | "arch" | "passage" => Kind::Opening,
                "open" | "none" | "no wall" | "open plan" => Kind::Open,
                k => bail!("{op}.kind must be door, window or opening, got \"{k}\""),
            };
            let names: Vec<String> = match o.get("between") {
                Some(Value::String(s)) => vec![s.clone()],
                Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(String::from).ok_or_else(|| anyhow!("{op}.between: room names are strings"))).collect::<Result<_>>()?,
                _ => bail!("{op}: needs \"between\": [room, other room or \"outside\"]"),
            };
            if names.is_empty() || names.len() > 2 {
                bail!("{op}.between: name one or two rooms (one means the room's outside wall)");
            }
            let is_out = |s: &str| matches!(s.trim().to_ascii_lowercase().as_str(), "outside" | "exterior" | "outdoors");
            let (na, nb) = (&names[0], names.get(1));
            let (na, nb) = if is_out(na) { (nb.ok_or_else(|| anyhow!("{op}.between: name a room"))?, Some(na)) } else { (na, nb) };
            if is_out(na) {
                bail!("{op}.between: at least one side must be a room");
            }
            let a = find_room(&rooms, na, &format!("{op}.between"))?;
            let b = match nb {
                Some(n) if !is_out(n) => Some(find_room(&rooms, n, &format!("{op}.between"))?),
                _ => None,
            };
            if b == Some(a) {
                bail!("{op}.between: the two rooms are the same");
            }
            let sd = o.get("side").and_then(|s| s.as_str()).map(|s| side(s, &format!("{op}.side"))).transpose()?;
            let at = o.get("at").filter(|x| !x.is_null()).map(|x| xy(x, &format!("{op}.at"))).transpose()?.map(|p| p + origin);
            let (dw, dh, ds) = match kind {
                Kind::Door => (0.9, 2.1, 0.0),
                Kind::Window => (1.2, 1.2, 0.9),
                Kind::Opening | Kind::Open => (1.2, 2.1, 0.0),
            };
            let width = opt_num(o, "width", &op)?.unwrap_or(dw);
            let sill = if kind == Kind::Window { opt_num(o, "sill", &op)?.unwrap_or(ds) } else { 0.0 };
            let mut height = opt_num(o, "height", &op)?.unwrap_or(dh);
            if !(0.3..=20.0).contains(&width) || !(0.3..=20.0).contains(&height) || !(0.0..=10.0).contains(&sill) {
                bail!("{op}: width and height must be 0.3 to 20 m and sill 0 to 10 m");
            }
            if sill + height > h - 0.05 {
                height = h - 0.05 - sill;
                if height < 0.3 {
                    bail!("{op}: sill {sill} m leaves no room for the window under the {h} m wall");
                }
            }
            openings.push(Opening { kind, a, b, side: sd, at, width, height, sill, path: op });
        }
        let mut stairs = Vec::new();
        if let Some(s) = f.get("stairs").filter(|s| !s.is_null()) {
            for (si, st) in s.as_array().ok_or_else(|| anyhow!("{fp}.stairs: expected a list"))?.iter().enumerate() {
                stairs.push(stair(st, origin, &format!("{fp}.stairs[{si}]"))?);
            }
        }
        floors.push(Floor { level: f.get("level").cloned().unwrap_or(json!(fi + 1)), elevation, height: h, rooms, openings, stairs });
    }
    // top-level stairs name the floor they start on
    if let Some(s) = v.get("stairs").filter(|s| !s.is_null()) {
        for (si, st) in s.as_array().ok_or_else(|| anyhow!("stairs: expected a list"))?.iter().enumerate() {
            let sp = format!("stairs[{si}]");
            let lv = st.get("level").cloned().unwrap_or(json!(1));
            let fi = floors.iter().position(|f| f.level == lv || f.level.as_f64().is_some_and(|x| Some(x) == lv.as_f64())).ok_or_else(|| anyhow!("{sp}.level: no floor with level {lv}"))?;
            floors[fi].stairs.push(stair(st, origin, &sp)?);
        }
    }
    Ok(Plan { name, thickness, floors })
}

fn stair(v: &Value, origin: DVec2, path: &str) -> Result<Stair> {
    let at = xy(v.get("at").ok_or_else(|| anyhow!("{path}: needs \"at\": [x, y] (the foot of the stair)"))?, &format!("{path}.at"))? + origin;
    let direction = match v.get("direction") {
        Some(Value::String(s)) => {
            let d = side(s, &format!("{path}.direction"))?;
            d.y.atan2(d.x).to_degrees()
        }
        Some(x) => num(x, &format!("{path}.direction"))?,
        None => 0.0,
    };
    let width = opt_num(v, "width", path)?.unwrap_or(1.0);
    let rise = opt_num(v, "rise", path)?;
    if !(0.5..=5.0).contains(&width) || rise.is_some_and(|r| !(0.2..=20.0).contains(&r)) {
        bail!("{path}: width must be 0.5 to 5 m and rise 0.2 to 20 m");
    }
    Ok(Stair { at, direction, width, rise })
}

fn inside(p: DVec2, ring: &[DVec2]) -> bool {
    let mut c = false;
    for i in 0..ring.len() {
        let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
        if (a.y > p.y) != (b.y > p.y) && p.x < a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x) {
            c = !c;
        }
    }
    c
}

fn sorted_unique(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.total_cmp(b));
    v.dedup_by(|a, b| (*a - *b).abs() < EPS);
    v
}

/// Two rooms whose insides overlap are a mistake in the plan.
fn check_overlaps(rooms: &[Room], fp: &str) -> Result<()> {
    let xs = sorted_unique(rooms.iter().flat_map(|r| r.ring.iter().map(|p| p.x)).collect());
    let ys = sorted_unique(rooms.iter().flat_map(|r| r.ring.iter().map(|p| p.y)).collect());
    for i in 0..xs.len().saturating_sub(1) {
        for j in 0..ys.len().saturating_sub(1) {
            let c = DVec2::new((xs[i] + xs[i + 1]) / 2.0, (ys[j] + ys[j + 1]) / 2.0);
            let hits: Vec<&str> = rooms.iter().filter(|r| inside(c, &r.ring)).map(|r| r.name.as_str()).collect();
            if hits.len() > 1 {
                bail!("{fp}: rooms \"{}\" and \"{}\" overlap (around {}); rooms share walls on their edges but must not overlap", hits[0], hits[1], fmt2(c));
            }
        }
    }
    Ok(())
}

// ----- walls ------------------------------------------------------------------------------------------------------

/// One room edge on a wall line. `horiz`: runs along x at `c` = y; else along y at `c` = x. `inside`: +1 when the
/// room is on the + side of the line.
#[derive(Clone, Copy, Debug)]
struct Edge {
    horiz: bool,
    c: f64,
    lo: f64,
    hi: f64,
    room: usize,
    inside: f64,
}

fn edges(rooms: &[Room]) -> Vec<Edge> {
    let mut out = Vec::new();
    for (ri, r) in rooms.iter().enumerate() {
        for i in 0..r.ring.len() {
            let (a, b) = (r.ring[i], r.ring[(i + 1) % r.ring.len()]);
            let d = b - a;
            // counter-clockwise: the inside is on the left
            if d.y.abs() < EPS {
                out.push(Edge { horiz: true, c: a.y, lo: a.x.min(b.x), hi: a.x.max(b.x), room: ri, inside: if d.x > 0.0 { 1.0 } else { -1.0 } });
            } else {
                out.push(Edge { horiz: false, c: a.x, lo: a.y.min(b.y), hi: a.y.max(b.y), room: ri, inside: if d.y > 0.0 { -1.0 } else { 1.0 } });
            }
        }
    }
    out
}

fn same_line(a: &Edge, b: &Edge) -> bool {
    a.horiz == b.horiz && (a.c - b.c).abs() < EPS
}

/// A wall run (a piece of a room's edge) an opening can go in.
#[derive(Clone, Copy, Debug)]
struct Seg {
    horiz: bool,
    c: f64,
    lo: f64,
    hi: f64,
    /// from room a, through the wall
    out: DVec2,
}

impl Seg {
    fn point(&self, s: f64) -> DVec2 {
        if self.horiz { DVec2::new(s, self.c) } else { DVec2::new(self.c, s) }
    }
    fn coord(&self, p: DVec2) -> f64 {
        if self.horiz { p.x } else { p.y }
    }
}

fn subtract(iv: Vec<(f64, f64)>, cut: (f64, f64)) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for (lo, hi) in iv {
        if cut.1 <= lo + EPS || cut.0 >= hi - EPS {
            out.push((lo, hi));
            continue;
        }
        if cut.0 > lo + EPS {
            out.push((lo, cut.0));
        }
        if cut.1 < hi - EPS {
            out.push((cut.1, hi));
        }
    }
    out
}

fn segments(es: &[Edge], a: usize, b: Option<usize>) -> Vec<Seg> {
    let mut out = Vec::new();
    for ea in es.iter().filter(|e| e.room == a) {
        let outv = if ea.horiz { DVec2::new(0.0, -ea.inside) } else { DVec2::new(-ea.inside, 0.0) };
        match b {
            Some(b) => {
                for eb in es.iter().filter(|e| e.room == b && same_line(e, ea) && e.inside != ea.inside) {
                    let (lo, hi) = (ea.lo.max(eb.lo), ea.hi.min(eb.hi));
                    if hi - lo > EPS {
                        out.push(Seg { horiz: ea.horiz, c: ea.c, lo, hi, out: outv });
                    }
                }
            }
            None => {
                let mut iv = vec![(ea.lo, ea.hi)];
                for eo in es.iter().filter(|e| e.room != a && same_line(e, ea)) {
                    iv = subtract(iv, (eo.lo, eo.hi));
                }
                for (lo, hi) in iv {
                    if hi - lo > EPS {
                        out.push(Seg { horiz: ea.horiz, c: ea.c, lo, hi, out: outv });
                    }
                }
            }
        }
    }
    out
}

/// The union of axis-aligned rectangles [x0, y0, x1, y1] as loops: counter-clockwise outlines, clockwise holes.
fn union_loops(rects: &[[f64; 4]], minus: &[[f64; 4]]) -> Vec<Vec<DVec2>> {
    let xs = sorted_unique(rects.iter().chain(minus).flat_map(|r| [r[0], r[2]]).collect());
    let ys = sorted_unique(rects.iter().chain(minus).flat_map(|r| [r[1], r[3]]).collect());
    let (nx, ny) = (xs.len().saturating_sub(1), ys.len().saturating_sub(1));
    let mut cov = vec![false; nx * ny];
    for i in 0..nx {
        for j in 0..ny {
            let (cx, cy) = ((xs[i] + xs[i + 1]) / 2.0, (ys[j] + ys[j + 1]) / 2.0);
            let hit = |r: &[f64; 4]| cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3];
            cov[i * ny + j] = rects.iter().any(hit) && !minus.iter().any(hit);
        }
    }
    let at = |i: isize, j: isize| i >= 0 && j >= 0 && (i as usize) < nx && (j as usize) < ny && cov[i as usize * ny + j as usize];
    // boundary edges with the covered side on the left
    let mut out: HashMap<(usize, usize), Vec<(usize, usize)>> = HashMap::new();
    let mut add = |a: (usize, usize), b: (usize, usize)| out.entry(a).or_default().push(b);
    for i in 0..nx {
        for j in 0..ny {
            if !cov[i * ny + j] {
                continue;
            }
            let (ii, jj) = (i as isize, j as isize);
            if !at(ii, jj - 1) {
                add((i, j), (i + 1, j));
            }
            if !at(ii + 1, jj) {
                add((i + 1, j), (i + 1, j + 1));
            }
            if !at(ii, jj + 1) {
                add((i + 1, j + 1), (i, j + 1));
            }
            if !at(ii - 1, jj) {
                add((i, j + 1), (i, j));
            }
        }
    }
    let mut starts: Vec<(usize, usize)> = out.keys().copied().collect();
    starts.sort();
    let mut loops = Vec::new();
    for s in starts {
        while out.get(&s).is_some_and(|v| !v.is_empty()) {
            let mut lp = vec![s];
            let mut cur = s;
            let mut dir = (0isize, 0isize);
            loop {
                let cands = out.get_mut(&cur).unwrap();
                // at a pinch (two ways on), turn left to keep hugging the same region
                let pick = (0..cands.len())
                    .max_by_key(|&k| {
                        let d = (cands[k].0 as isize - cur.0 as isize, cands[k].1 as isize - cur.1 as isize);
                        let (dx, dy) = (d.0.signum(), d.1.signum());
                        dir.0 * dy - dir.1 * dx
                    })
                    .unwrap();
                let nxt = cands.swap_remove(pick);
                dir = ((nxt.0 as isize - cur.0 as isize).signum(), (nxt.1 as isize - cur.1 as isize).signum());
                cur = nxt;
                if cur == s {
                    break;
                }
                lp.push(cur);
                if out.get(&cur).is_none_or(|v| v.is_empty()) {
                    break;
                }
            }
            let mut pts: Vec<DVec2> = lp.iter().map(|&(i, j)| DVec2::new(xs[i], ys[j])).collect();
            let mut k = 0;
            while pts.len() > 2 && k < pts.len() {
                let n = pts.len();
                let (a, b, c) = (pts[(k + n - 1) % n], pts[k], pts[(k + 1) % n]);
                if (b - a).perp_dot(c - b).abs() < 1e-12 {
                    pts.remove(k);
                } else {
                    k += 1;
                }
            }
            if pts.len() >= 3 {
                loops.push(pts);
            }
        }
    }
    loops
}

/// A ring moved `d` inward (orthogonal, counter-clockwise).
fn inset(ring: &[DVec2], d: f64) -> Vec<DVec2> {
    let n = ring.len();
    let left = |a: DVec2, b: DVec2| {
        let u = (b - a).normalize();
        DVec2::new(-u.y, u.x)
    };
    (0..n)
        .map(|i| {
            let (p, c, q) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            let (n1, n2) = (left(p, c), left(c, q));
            c + (n1 + n2) / (1.0 + n1.dot(n2)) * d
        })
        .collect()
}

fn up_face(m: &mut Model, pts: &[DVec3]) -> Result<Id> {
    let f = m.add_polygon(pts)?;
    if m.normal(f).z < 0.0 {
        m.faces.get_mut(&f).unwrap().reverse();
    }
    Ok(f)
}

/// Cut a rectangular hole through a wall of `group`: `s0..s1` along the run, `z0..z1` up, through `t`.
fn cut_through(m: &mut Model, group: Id, seg: &Seg, s0: f64, s1: f64, z0: f64, z1: f64, t: f64, floor_z: f64) -> Result<()> {
    let h = t / 2.0;
    let p = |s: f64, off: f64, z: f64| {
        let q = seg.point(s) + if seg.horiz { DVec2::new(0.0, off) } else { DVec2::new(off, 0.0) };
        q.extend(z)
    };
    let n = if seg.horiz { DVec3::Y } else { DVec3::X };
    let rect = |off: f64| vec![p(s0, off, z0), p(s1, off, z0), p(s1, off, z1), p(s0, off, z1)];
    let (front, back) = (rect(h), rect(-h));
    let a = crate::openings::cut_on_plane(m, &front, n, Some(group))?;
    let b = crate::openings::cut_on_plane(m, &back, -n, Some(group))?;
    if a == 0 || b == 0 {
        bail!("the opening at {} does not fit in the wall", fmt2(seg.point((s0 + s1) / 2.0)));
    }
    let on_floor = (z0 - floor_z).abs() < EPS;
    let keep = m.active_group;
    m.active_group = Some(group);
    let c = p((s0 + s1) / 2.0, 0.0, (z0 + z1) / 2.0);
    for i in 0..4 {
        if i == 0 && on_floor {
            continue;
        }
        let j = (i + 1) % 4;
        let quad = [front[i], front[j], back[j], back[i]];
        let id = m.add_polygon(&quad)?;
        let mid = (quad[0] + quad[1] + quad[2] + quad[3]) / 4.0;
        if m.normal(id).dot(c - mid) < 0.0 {
            m.faces.get_mut(&id).unwrap().reverse();
        }
    }
    m.active_group = keep;
    Ok(())
}

/// Where each opening goes: (segment, s0, s1). Errors name the opening and what would fit.
fn place_openings(fl: &Floor, es: &[Edge], t: f64) -> Result<Vec<(Seg, f64, f64)>> {
    let mut placed: Vec<(Seg, f64, f64, f64, f64, String)> = Vec::new();
    for o in &fl.openings {
        let other = o.b.map(|b| fl.rooms[b].name.clone()).unwrap_or_else(|| "outside".into());
        let an = &fl.rooms[o.a].name;
        let mut segs = segments(es, o.a, o.b);
        if segs.is_empty() {
            bail!("{}: \"{an}\" and \"{other}\" share no wall", o.path);
        }
        if let Some(sd) = o.side {
            let all = segs.clone();
            segs.retain(|s| s.out.distance(sd) < 1e-9);
            if segs.is_empty() {
                let names: Vec<&str> = all.iter().map(|s| if s.out.y > 0.5 { "north" } else if s.out.y < -0.5 { "south" } else if s.out.x > 0.5 { "east" } else { "west" }).collect();
                bail!("{}: \"{an}\" meets \"{other}\" only on its {} side", o.path, sorted_names(names));
            }
        }
        // usable part of each run: clear of the walls at its ends
        let fits = |s: &Seg| (s.lo + t / 2.0, s.hi - t / 2.0);
        let seg = match o.at {
            Some(p) => *segs
                .iter()
                .min_by(|x, y| {
                    let dx = |s: &Seg| s.point(s.coord(p).clamp(s.lo, s.hi)).distance(p);
                    dx(x).total_cmp(&dx(y))
                })
                .unwrap(),
            None => *segs.iter().max_by(|x, y| (x.hi - x.lo).total_cmp(&(y.hi - y.lo))).unwrap(),
        };
        if o.kind == Kind::Open {
            // the whole shared edge goes; nothing to fit
            placed.push((seg, seg.lo, seg.hi, -1.0, -1.0, o.path.clone()));
            continue;
        }
        let (u0, u1) = fits(&seg);
        if u1 - u0 < o.width - EPS {
            bail!("{}: the {:.2} m opening does not fit the {:.2} m clear wall between \"{an}\" and \"{other}\"; make it at most {:.2} m wide", o.path, o.width, (u1 - u0).max(0.0), ((u1 - u0) * 100.0).floor() / 100.0);
        }
        let want = o.at.map(|p| seg.coord(p)).unwrap_or((seg.lo + seg.hi) / 2.0);
        let mid = want.clamp(u0 + o.width / 2.0, u1 - o.width / 2.0);
        let (s0, s1) = (mid - o.width / 2.0, mid + o.width / 2.0);
        let (z0, z1) = (o.sill, o.sill + o.height);
        for (ps, a0, a1, b0, b1, pp) in &placed {
            if ps.horiz == seg.horiz && (ps.c - seg.c).abs() < EPS && s0 < *a1 + 0.05 && s1 > *a0 - 0.05 && z0 < *b1 && z1 > *b0 {
                bail!("{}: overlaps {pp} on the same wall; move one with \"at\" or make them narrower", o.path);
            }
        }
        placed.push((seg, s0, s1, z0, z1, o.path.clone()));
    }
    Ok(placed.into_iter().map(|(s, a, b, ..)| (s, a, b)).collect())
}

fn sorted_names(mut v: Vec<&str>) -> String {
    v.sort();
    v.dedup();
    v.join(" and ")
}

impl Model {
    /// Build a checked plan (see the module docs). Returns the reply.
    pub fn floorplan_build(&mut self, plan: &Plan) -> Result<Value> {
        let t = plan.thickness;
        // place every opening first: a plan that can't be built changes nothing
        let mut placements = Vec::new();
        for fl in &plan.floors {
            let es = edges(&fl.rooms);
            placements.push((es.clone(), place_openings(fl, &es, t)?));
        }
        let prev = self.active_group;
        let top = self.begin_group(plan.name.clone());
        let r = self.floorplan_inner(plan, placements, top);
        self.active_group = prev;
        match r {
            Ok(v) => Ok(json!({"group": top, "floors": v, "rooms": plan.floors.iter().map(|f| f.rooms.len()).sum::<usize>()})),
            Err(e) => {
                self.delete(&[top]).ok();
                Err(e)
            }
        }
    }

    fn floorplan_inner(&mut self, plan: &Plan, placements: Vec<(Vec<Edge>, Vec<(Seg, f64, f64)>)>, top: Id) -> Result<Vec<Value>> {
        let t = plan.thickness;
        let mut floors = Vec::new();
        for (fi, (fl, (es, places))) in plan.floors.iter().zip(placements).enumerate() {
            self.check_deadline()?;
            let z = fl.elevation;
            self.active_group = Some(top);
            let level_name = match &fl.level {
                Value::String(s) => s.chars().take(40).collect(),
                v => format!("Level {v}"),
            };
            let fg = self.begin_group(level_name);
            // walls: every edge on a line merged into runs, the runs unioned into one footprint
            let mut lines: Vec<(bool, f64, Vec<(f64, f64)>)> = Vec::new();
            for e in &es {
                match lines.iter_mut().find(|(h, c, _)| *h == e.horiz && (*c - e.c).abs() < EPS) {
                    Some(l) => l.2.push((e.lo, e.hi)),
                    None => lines.push((e.horiz, e.c, vec![(e.lo, e.hi)])),
                }
            }
            // open edges: no wall there (merge first, then take the open piece out)
            let opens: Vec<&(Seg, f64, f64)> = fl.openings.iter().zip(&places).filter(|(o, _)| o.kind == Kind::Open).map(|(_, p)| p).collect();
            for l in &mut lines {
                l.2.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut merged: Vec<(f64, f64)> = Vec::new();
                for &(lo, hi) in &l.2 {
                    match merged.last_mut() {
                        Some(last) if lo <= last.1 + EPS => last.1 = last.1.max(hi),
                        _ => merged.push((lo, hi)),
                    }
                }
                for (_, lo, hi) in opens.iter().filter(|(sg, ..)| sg.horiz == l.0 && (sg.c - l.1).abs() < EPS) {
                    merged = subtract(merged, (*lo, *hi));
                }
                l.2 = merged;
            }
            let mut rects = Vec::new();
            for (horiz, c, mut iv) in lines {
                iv.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut merged: Vec<(f64, f64)> = Vec::new();
                for (lo, hi) in iv {
                    match merged.last_mut() {
                        Some(last) if lo <= last.1 + EPS => last.1 = last.1.max(hi),
                        _ => merged.push((lo, hi)),
                    }
                }
                for (lo, hi) in merged {
                    let h = t / 2.0;
                    rects.push(if horiz { [lo - h, c - h, hi + h, c + h] } else { [c - h, lo - h, c + h, hi + h] });
                }
            }
            let loops = union_loops(&rects, &[]);
            self.active_group = Some(fg);
            let wg = self.begin_group("Walls".into());
            let (outers, holes): (Vec<_>, Vec<_>) = loops.into_iter().partition(|l| signed_area(l) > 0.0);
            for f in faces_with_holes(self, &outers, &holes, z)? {
                self.pushpull(f, fl.height)?;
            }
            let mut ops = Vec::new();
            for (o, (seg, s0, s1)) in fl.openings.iter().zip(&places) {
                self.check_deadline()?;
                if o.kind == Kind::Open {
                    ops.push(json!({"kind": "open", "between": [fl.rooms[o.a].name, o.b.map(|b| fl.rooms[b].name.clone()).unwrap_or_else(|| "outside".into())], "length": r3(s1 - s0)}));
                    continue;
                }
                cut_through(self, wg, seg, *s0, *s1, z + o.sill, z + o.sill + o.height, t, z)?;
                let c = seg.point((s0 + s1) / 2.0);
                ops.push(json!({
                    "kind": match o.kind { Kind::Door => "door", Kind::Window => "window", Kind::Opening => "opening", Kind::Open => "open" },
                    "between": [fl.rooms[o.a].name, o.b.map(|b| fl.rooms[b].name.clone()).unwrap_or_else(|| "outside".into())],
                    "at": [r3(c.x), r3(c.y), r3(z + o.sill)], "width": r3(s1 - s0), "height": r3(o.height),
                }));
            }
            // drawing a door's outline on the wall's underside lets the modeler re-find the room loops as faces,
            // so the underside is rebuilt from the footprint without the doorways
            let gaps: Vec<[f64; 4]> = fl.openings.iter().zip(&places).filter(|(o, _)| o.sill < EPS && o.kind != Kind::Open).map(|(_, (sg, s0, s1))| {
                let h = t / 2.0;
                if sg.horiz { [*s0, sg.c - h, *s1, sg.c + h] } else { [sg.c - h, *s0, sg.c + h, *s1] }
            }).collect();
            if !gaps.is_empty() {
                let dead: Vec<Id> = self.faces.iter().filter(|(id, f)| f.group == Some(wg) && self.normal(**id).z < -0.5 && f.outer.iter().all(|v| (self.p(*v).z - z).abs() < EPS)).map(|(id, _)| *id).collect();
                for id in dead {
                    self.faces.remove(&id);
                }
                let (outers, holes): (Vec<_>, Vec<_>) = union_loops(&rects, &gaps).into_iter().partition(|l| signed_area(l) > 0.0);
                for f in faces_with_holes(self, &outers, &holes, z)? {
                    self.faces.get_mut(&f).unwrap().reverse();
                }
            }
            self.set_tag(&[wg], Some("Walls".into()))?;
            // a floor face in each room, in a group named after it
            let mut rooms = Vec::new();
            let mut room_ids = Vec::new();
            for r in &fl.rooms {
                self.active_group = Some(fg);
                let rg = self.begin_group(r.name.clone());
                // the floor runs to the wall centerlines (under the walls and through doorways); the area
                // reported is the clear area inside the walls
                let inner = inset(&r.ring, t / 2.0);
                if r.floor {
                    up_face(self, &r.ring.iter().map(|p| p.extend(z)).collect::<Vec<_>>())?;
                }
                room_ids.push(rg);
                let b = r.ring.iter().fold((DVec2::splat(f64::MAX), DVec2::splat(f64::MIN)), |(a, b), p| (a.min(*p), b.max(*p)));
                rooms.push(json!({"name": r.name, "group": rg, "area": r3(signed_area(&inner)), "gross_area": r3(signed_area(&r.ring)), "size": [r3(b.1.x - b.0.x), r3(b.1.y - b.0.y)]}));
            }
            self.set_tag(&room_ids, Some("Rooms".into()))?;
            // stairs climb to the next floor (or one floor height)
            let mut st = Vec::new();
            for s in &fl.stairs {
                self.active_group = Some(fg);
                let rise = s.rise.unwrap_or_else(|| plan.floors.get(fi + 1).map(|n| n.elevation - z).filter(|r| *r > 0.2).unwrap_or(fl.height));
                let (g, n) = self.stairs(s.at.extend(z), s.direction, s.width, rise, 0.28)?;
                st.push(json!({"group": g, "risers": n, "rise": r3(rise)}));
            }
            floors.push(json!({"level": fl.level, "elevation": r3(z), "group": fg, "walls": wg, "rooms": rooms, "openings": ops, "stairs": st}));
        }
        Ok(floors)
    }
}

/// Up-facing faces at height `z`: each outline with the holes inside it.
fn faces_with_holes(m: &mut Model, outers: &[Vec<DVec2>], holes: &[Vec<DVec2>], z: f64) -> Result<Vec<Id>> {
    let mut out = Vec::new();
    for o in outers {
        let f = up_face(m, &o.iter().map(|p| p.extend(z)).collect::<Vec<_>>())?;
        // a point just inside the hole's first edge (holes run clockwise: the hole is on the right)
        for hl in holes.iter().filter(|hl| inside(hl[0] + (hl[1] - hl[0]) * 0.5 - (hl[1] - hl[0]).normalize().perp() * 1e-4, o)) {
            let hf = m.add_polygon(&hl.iter().map(|p| p.extend(z)).collect::<Vec<_>>())?;
            m.delete(&[hf])?;
        }
        out.push(f);
    }
    Ok(out)
}

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
