//! Where every part of a model would lie if it were taken apart and laid flat on the ground: each part on its
//! biggest face with its length along red, longest first, parts of the same size and material next to each other,
//! a gap between them. Worked out from the model as it is; nothing in the model moves. Each part's frame is
//! `plugins::measure`'s, the same one `parts` reports.

use crate::model::{Id, Model};
use crate::plugins::{measure, tidy, tidy3, Measured};
use anyhow::{bail, Result};
use glam::{DMat3, DMat4, DVec3};
use serde_json::{json, Value};

/// The widest gap that can be asked for, in meters.
pub const MAX_GAP: f64 = 10.0;

/// A part and where it lies in the lay-out.
pub struct Laid {
    pub part: Measured,
    /// takes the part from where it is in the model to where it lies: a turn and a move, never a mirror
    pub transform: DMat4,
    /// the box it lies in
    pub min: DVec3,
    pub max: DVec3,
}

/// The gap when none is asked for: 4% of the longest part, between 5 mm and 100 mm, so a shed's studs and a
/// printed bracket's pieces both read.
fn default_gap(parts: &[Measured]) -> f64 {
    let longest = parts.iter().map(|p| p.size[0]).fold(0.0, f64::max);
    (0.04 * longest).clamp(0.005, 0.1)
}

/// Lay out `ids` (groups or components), or every part when there are none. Returns the parts in lay-out order and
/// the gap used. The lay-out sits under the parts: the same middle seen from above, resting at their lowest point.
pub fn lay_out(m: &Model, ids: &[Id], gap: Option<f64>) -> Result<(Vec<Laid>, f64)> {
    if let Some(g) = gap {
        if !g.is_finite() || !(0.0..=MAX_GAP).contains(&g) {
            bail!("the gap must be between 0 and {MAX_GAP} meters");
        }
    }
    let mut parts = measure(m, ids);
    let gap = gap.unwrap_or_else(|| default_gap(&parts));
    // longest first; the same size (to the millimeter) and material is the key Cut list counts by, so equal parts
    // end up next to each other; then by name and id, so the order never depends on how the model is stored
    let mm = |p: &Measured| p.size.map(|x| (x * 1000.0).round() as i64);
    parts.sort_by(|a, b| mm(b).cmp(&mm(a)).then_with(|| a.material.cmp(&b.material)).then_with(|| a.name.cmp(&b.name)).then_with(|| a.id.cmp(&b.id)));
    // where the parts are now
    let (mut lo, mut hi) = (DVec3::splat(f64::MAX), DVec3::splat(f64::MIN));
    for p in &parts {
        for k in 0..8 {
            let c = p.origin + p.u * (if k & 1 == 0 { 0.0 } else { p.extent.x }) + p.w * (if k & 2 == 0 { 0.0 } else { p.extent.y }) + p.n * (if k & 4 == 0 { 0.0 } else { p.extent.z });
            lo = lo.min(c);
            hi = hi.max(c);
        }
    }
    // rows from the back to the front, each filled left to right; about as wide as it is deep
    let area: f64 = parts.iter().map(|p| (p.extent.x + gap) * (p.extent.y + gap)).sum();
    let width = parts.iter().map(|p| p.extent.x).fold(area.sqrt(), f64::max);
    let (mut x, mut y, mut depth) = (0.0, 0.0, 0.0f64);
    let mut slots = Vec::with_capacity(parts.len());
    for p in &parts {
        if x > 0.0 && x + p.extent.x > width + 1e-9 {
            y -= depth + gap;
            x = 0.0;
            depth = 0.0;
        }
        slots.push(DVec3::new(x, y - p.extent.y, 0.0));
        x += p.extent.x + gap;
        depth = depth.max(p.extent.y);
    }
    let (mut flat_lo, mut flat_hi) = (DVec3::splat(f64::MAX), DVec3::splat(f64::MIN));
    for (p, s) in parts.iter().zip(&slots) {
        flat_lo = flat_lo.min(*s);
        flat_hi = flat_hi.max(*s + p.extent);
    }
    let shift = DVec3::new((lo.x + hi.x - flat_lo.x - flat_hi.x) / 2.0, (lo.y + hi.y - flat_lo.y - flat_hi.y) / 2.0, lo.z);
    let laid = parts
        .into_iter()
        .zip(slots)
        .map(|(part, slot)| {
            let min = slot + shift;
            let max = min + part.extent;
            // the biggest face down and the length along red: u -> +x, n -> -z, and so w -> -y (a turn, no mirror)
            let turn = DMat3::from_cols(part.u, -part.w, -part.n).transpose();
            let turn = DMat3::from_cols_array(&turn.to_cols_array().map(|v| tidy(v, 1e-12)));
            let transform = DMat4::from_translation(min + DVec3::new(0.0, part.extent.y, part.extent.z)) * DMat4::from_mat3(turn) * DMat4::from_translation(-part.origin);
            Laid { part, transform, min, max }
        })
        .collect();
    Ok((laid, gap))
}

/// The reply to `parts_layout`.
pub fn reply(m: &Model, ids: &[Id], gap: Option<f64>) -> Result<Value> {
    let (laid, gap) = lay_out(m, ids, gap)?;
    let bounds = (!laid.is_empty()).then(|| {
        let (lo, hi) = laid.iter().fold((DVec3::splat(f64::MAX), DVec3::splat(f64::MIN)), |(lo, hi), l| (lo.min(l.min), hi.max(l.max)));
        json!({"min": tidy3(lo, 1e-9), "max": tidy3(hi, 1e-9)})
    });
    let parts: Vec<Value> = laid
        .iter()
        .map(|l| {
            json!({
                "id": l.part.id, "name": l.part.name, "kind": l.part.kind, "material": l.part.material, "size": l.part.size,
                "transform": l.transform.to_cols_array().map(|v| tidy(v, 1e-12)),
                "min": tidy3(l.min, 1e-9), "max": tidy3(l.max, 1e-9),
            })
        })
        .collect();
    Ok(json!({"parts": parts, "gap": gap, "bounds": bounds, "units": m.units}))
}
