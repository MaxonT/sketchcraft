// Regenerate: node tools/minimodel/fixtures/townhouse.mjs > tools/minimodel/fixtures/townhouse.plan.json
// Townhouse plan from the drawing (feet, SVG y down; y=48 is the front) -> floorplan_build JSON in meters.
const F = 0.3048, r3 = (x) => Math.round(x * 1000) / 1000;
const P = (x, y) => [r3(x * F), r3((48 - y) * F)];
const rect = (x0, y0, x1, y1) => { const [a, b] = P(x0, y1); return [a, b, r3((x1 - x0) * F), r3((y1 - y0) * F)]; };
const poly = (...pts) => pts.map(([x, y]) => P(x, y));
const d = (between, at, wft, extra = {}) => ({ kind: "door", between, at: P(...at), width: r3(wft * F), ...extra });
const w = (room, at, wft, extra = {}) => ({ kind: "window", between: [room, "outside"], at: P(...at), width: r3(wft * F), ...extra });
const open = (a, b) => ({ kind: "open", between: [a, b] });
const plan = {
  name: "Two-story townhouse", wall_thickness: 0.15,
  floors: [
    { level: 1, wall_height: 2.6, rooms: [
      { name: "Primary Bedroom", rect: rect(0, 0, 13, 13) }, { name: "Bath 1", rect: rect(13, 0, 22, 8) }, { name: "WIC", rect: rect(13, 8, 22, 13) },
      { name: "Kitchen / Living / Dining", rect: rect(0, 13, 22, 28) }, { name: "Pantry", rect: rect(11, 28, 15, 32) }, { name: "Laundry", rect: rect(11, 32, 15, 40) },
      { name: "Garage", rect: rect(0, 28, 11, 48) }, { name: "Hall", rect: rect(15, 28, 18.5, 40) }, { name: "Stair", rect: rect(18.5, 28, 22, 40) }, { name: "Foyer", rect: rect(11, 40, 22, 48) }],
      openings: [
        d(["Primary Bedroom", "Kitchen / Living / Dining"], [10.9, 13], 2.8), d(["Primary Bedroom", "Bath 1"], [13, 4.25], 2.5), d(["Primary Bedroom", "WIC"], [13, 10.25], 2.5),
        d(["Pantry", "Kitchen / Living / Dining"], [12.75, 28], 2.5), open("Hall", "Kitchen / Living / Dining"), open("Hall", "Foyer"), open("Stair", "Foyer"),
        d(["Laundry", "Hall"], [15, 35.5], 4), d(["Garage", "Foyer"], [11, 42.5], 3),
        d(["Foyer", "outside"], [15, 48], 3), d(["Garage", "outside"], [5.5, 48], 8, { height: r3(7 * F) }),
        w("Primary Bedroom", [6.5, 0], 7), w("Bath 1", [15.75, 0], 2.5, { sill: 1.2, height: 0.9 }), w("Kitchen / Living / Dining", [22, 17], 4), w("Kitchen / Living / Dining", [22, 24], 4),
        w("Foyer", [22, 43.5], 3), w("Foyer", [19.75, 48], 2.5)],
      stairs: [{ at: [6.626, 2.4], direction: 90, width: 0.9 }] },
    { level: 2, wall_height: 2.45, rooms: [
      { name: "Bed 2", rect: rect(0, 13, 12, 25) }, { name: "Bed 3", rect: rect(12, 13, 22, 25) }, { name: "Bath 2", rect: rect(0, 25, 8, 33) },
      { name: "Hall", polygon: poly([8, 25], [8, 33], [18.5, 33], [18.5, 28], [22, 28], [22, 25]) },
      { name: "Stair", rect: rect(18.5, 28, 22, 40), floor: false },
      { name: "Loft", polygon: poly([0, 33], [0, 48], [22, 48], [22, 40], [18.5, 40], [18.5, 33]) }],
      openings: [
        d(["Bed 2", "Hall"], [10, 25], 2.8), d(["Bed 3", "Hall"], [13.9, 25], 2.8), d(["Bath 2", "Hall"], [8, 28.25], 2.5), open("Hall", "Loft"), open("Hall", "Stair"),
        w("Bed 2", [6, 13], 5), w("Bed 3", [16.25, 13], 3.5), w("Bed 3", [22, 18], 4), w("Loft", [22, 44.25], 3.5), w("Loft", [6, 48], 6), w("Loft", [15, 48], 6)] }],
};
process.stdout.write(JSON.stringify(plan, null, 1) + "\n");
