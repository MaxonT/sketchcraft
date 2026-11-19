// The slice of SketchCraft's command language the small model may speak (~36 of the engine's ~170 commands),
// as one table. From it we generate BOTH the compact reference in the prompt and the JSON schema handed to
// Ollama as `format` (so output can only be a valid command list). `check_spec` verifies every name here is
// a real variant of the Command enum and is in the agent allowlist (policy.rs), so the table can't drift.
//
// type codes: v3 = [x,y,z] meters, n = number, i = integer, s = string, b = boolean, id = id or "@name",
// ids = list of ids, pts = list of v3, fac = number or v3. A trailing ? = optional.
export const ASSETS = ["door", "window", "garage_door", "tree", "palm", "car", "streetlight", "bench", "hydrant"];
export const ROOFS = ["gable", "hip", "shed"];

export const COMMANDS = [
  ["rect", { from: "v3", to: "v3", as: "s?" }, "axis-aligned rectangle; both corners share one coordinate (z equal = on the ground). On an existing face it cuts a hole (window) or splits it (door)"],
  ["polygon", { points: "pts", as: "s?" }, "flat face from points"],
  ["line", { points: "pts" }, "edges"],
  ["circle", { center: "v3", radius: "n", as: "s?" }, "flat circle (radius, not diameter)"],
  ["offset", { face: "id", distance: "n", as: "s?" }, "+ shrinks a face inward (new inner face), - grows outward"],
  ["pushpull", { face: "id", distance: "n", toward: "v3?", as: "s?" }, "extrude a face by distance (- pushes in); returns the new far face as `face`; toward:[0,0,1] forces up"],
  ["move", { ids: "ids", by: "v3" }, "move groups/faces by an offset"],
  ["rotate", { ids: "ids", center: "v3", axis: "v3?", angle: "n" }, "rotate about a point, axis default [0,0,1], degrees, counter-clockwise from above"],
  ["scale", { ids: "ids", center: "v3", factor: "fac" }, "uniform number or [x,y,z] factors, about center"],
  ["duplicate", { ids: "ids", by: "v3" }, "one copy offset by `by`"],
  ["array", { ids: "ids", by: "v3", count: "i" }, "`count` MORE copies spaced `by` apart (total = count+1)"],
  ["copy", { group: "id", by: "v3", as: "s?" }, "copy a group, offset by `by`"],
  ["delete", { ids: "ids" }, ""],
  ["paint", { ids: "ids", color: "v3" }, "color as [r,g,b] each 0..1; painting a group paints all its faces"],
  ["begin_group", { name: "s?", as: "s?" }, "start a group: everything drawn until end_group belongs to it"],
  ["end_group", {}, ""],
  ["group", { ids: "ids", name: "s?", as: "s?" }, ""],
  ["rename", { id: "id", name: "s" }, ""],
  ["tag", { ids: "ids", tag: "s" }, ""],
  ["hide", { ids: "ids" }, ""],
  ["unhide", { ids: "ids?" }, ""],
  ["make_component", { ids: "ids", name: "s?", as: "s?" }, ""],
  ["place", { component: "s", at: "v3" }, "another instance of a component by name"],
  ["wall", { points: "pts", thickness: "n?", height: "n?", closed: "b?", as: "s?" }, "walls along a path (a group); thickness default 0.2, height 2.7; closed:true makes a room"],
  ["stairs", { at: "v3", rise: "n", direction: "n?", width: "n?", as: "s?" }, "straight stair climbing `rise`; direction degrees from +X (0=east, 90=north); width default 1"],
  ["roof", { face: "id", kind: "roofkind?", pitch: "n?", overhang: "n?", as: "s?" }, "roof (a group) over a flat top face; kind gable|hip|shed; pitch in degrees"],
  ["column", { at: "v3", size: "n?", height: "n?", round: "b?", as: "s?" }, "square column centered at `at`; size default 0.3, height 2.7"],
  ["insert", { asset: "asset", at: "v3", rotate: "n?" }, "built-in door window garage_door tree palm car streetlight bench hydrant"],
  ["dimension", { from: "v3", to: "v3", offset: "v3?" }, "dimension line; replies with its length"],
  ["undo", {}, "take back the last step"],
  ["info", {}, "READ-ONLY: counts, bounds, groups, instances, materials"],
  ["parts", { ids: "ids?" }, "READ-ONLY: each group/component's true size (sorted)"],
  ["faces", {}, "READ-ONLY: every face (id, normal, center, area, material, group)"],
  ["volume", { id: "id" }, "READ-ONLY: volume of a closed group"],
  ["pick", { at: "v3", as: "s?" }, "the face under a point (remember it with as)"],
];

const NAME = "^@?[A-Za-z0-9_]{1,32}$";
const ID = { anyOf: [{ type: "integer" }, { type: "string", pattern: "^@[A-Za-z0-9_]{1,32}$" }] };
const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const TYPES = {
  v3: V3, n: { type: "number" }, i: { type: "integer", minimum: 1, maximum: 200 }, s: { type: "string", maxLength: 40 }, b: { type: "boolean" },
  id: ID, ids: { type: "array", items: ID, minItems: 1, maxItems: 12 }, pts: { type: "array", items: V3, minItems: 2, maxItems: 24 },
  fac: { anyOf: [{ type: "number" }, V3] }, roofkind: { enum: ROOFS }, asset: { enum: ASSETS },
};
const T = (code) => TYPES[code.replace("?", "")];

/** JSON schema for Ollama's `format`: {"commands":[ one of the typed commands, ... ]} */
export function buildSchema(only = null) {
  const variants = COMMANDS.filter(([n]) => !only || only.includes(n)).map(([name, fields]) => {
    const props = { cmd: { const: name } };
    const required = ["cmd"];
    for (const [k, code] of Object.entries(fields)) {
      props[k] = k === "as" ? { type: "string", pattern: NAME } : T(code);
      if (!code.endsWith("?")) required.push(k);
    }
    return { type: "object", properties: props, required, additionalProperties: false };
  });
  return { type: "object", properties: { commands: { type: "array", items: { anyOf: variants }, minItems: 1, maxItems: 40 } }, required: ["commands"], additionalProperties: false };
}

const SHORT = { v3: "[x,y,z]", n: "number", i: "int", s: "string", b: "bool", id: "id", ids: "[id,..]", pts: "[[x,y,z],..]", fac: "n|[x,y,z]", roofkind: "gable|hip|shed", asset: "asset" };
/** The compact reference put in the prompt, generated from the table (about 900 tokens). */
export function buildReference(only = null) {
  const lines = COMMANDS.filter(([n]) => !only || only.includes(n)).map(([name, fields, doc]) => {
    const f = Object.entries(fields).map(([k, c]) => (c.endsWith("?") ? `${k}?` : k) + (c.startsWith("n") || c.startsWith("i") ? "" : "")).join(", ");
    return `${name}${f ? " {" + f + "}" : ""}${doc ? ": " + doc : ""}`;
  });
  return [
    "You turn a plain-English request into SketchCraft commands. Output JSON: {\"commands\":[ ... ]}, each command an object with \"cmd\".",
    "Units are meters (convert feet/inches/cm/mm to meters). Z is up. +X east, +Y north (south = -Y), -Y is the front. Angles in degrees.",
    "\"as\":\"name\" remembers a result id (face, group, instance); use \"@name\" wherever an id goes. Names listed in the model state are already usable as @name.",
    "To make a solid object you will paint, move or copy as a whole: begin_group (as:name), rect, pushpull, end_group, then act on \"@name\".",
    "Questions (how big, what is there, where) use only the READ-ONLY commands and change nothing.",
    "Commands:",
    ...lines,
  ].join("\n");
}

// Hand-written worked examples (none is an eval request). [request, answer, fixture-or-null]. `--shots N` uses the first N.
export const FEW_SHOT = [
  ["a 3 by 2 meter box 1.5 m tall", { commands: [{ cmd: "begin_group", name: "box", as: "box" }, { cmd: "rect", from: [0, 0, 0], to: [3, 2, 0], as: "f" }, { cmd: "pushpull", face: "@f", distance: 1.5 }, { cmd: "end_group" }] }, null],
  ["move the house 5 m east and paint it red", { commands: [{ cmd: "move", ids: ["@house"], by: [5, 0, 0] }, { cmd: "paint", ids: ["@house"], color: [1, 0, 0] }] }, "house"],
  ["a 5x4 room with 2.5 m walls", { commands: [{ cmd: "wall", points: [[0, 0, 0], [5, 0, 0], [5, 4, 0], [0, 4, 0]], thickness: 0.2, height: 2.5, closed: true }] }, null],
  ["how tall is the tower?", { commands: [{ cmd: "parts", ids: ["@tower"] }] }, "tower"],
  ["a green 2 m cube 4 m east of the origin", { commands: [{ cmd: "begin_group", name: "cube", as: "cube" }, { cmd: "rect", from: [4, 0, 0], to: [6, 2, 0], as: "f" }, { cmd: "pushpull", face: "@f", distance: 2 }, { cmd: "end_group" }, { cmd: "paint", ids: ["@cube"], color: [0, 0.6, 0] }] }, null],
  ["an L-shaped wall, 5 m along x then 3 m along y, 3 m high", { commands: [{ cmd: "wall", points: [[0, 0, 0], [5, 0, 0], [5, 3, 0]], height: 3 }] }, null],
  ["put a 30 degree shed roof on the tower", { commands: [{ cmd: "roof", face: "@top", kind: "shed", pitch: 30 }] }, "tower"],
  ["three more posts in a line along y, 1.5 m apart", { commands: [{ cmd: "array", ids: ["@post"], by: [0, 1.5, 0], count: 3 }] }, "post"],
];

// The SHORT system prompt used for fine-tuning (Phase 2) and for scoring a fine-tuned model (`run_eval --prompt short`):
// no command reference and no examples; the tuned model has learned the table. Keep training and eval in sync.
export const SHORT_SYSTEM = [
  "You are SketchCraft's modeling assistant. Turn the request into SketchCraft commands.",
  "Reply with JSON only: {\"commands\":[...]}, each command an object with \"cmd\". Meters, Z up, +X east, +Y north, degrees.",
  "Questions use only read-only commands (info, parts, faces, volume). Anything outside modeling (files, network, programs) gets {\"commands\":[{\"cmd\":\"info\"}]}.",
].join("\n");
/** one chat example as trained and as scored: [system, user, (assistant)] */
export const chatMessages = (state, request, commands = null) => [
  { role: "system", content: SHORT_SYSTEM },
  { role: "user", content: `Model state: ${state}\nRequest: ${request}` },
  ...(commands ? [{ role: "assistant", content: JSON.stringify({ commands }) }] : []),
];
