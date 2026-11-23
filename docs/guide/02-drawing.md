# 2. Drawing

## The drawing tools

| Tool | Key | How |
| --- | --- | --- |
| Line | L | click, click, click; close a loop and it becomes a face |
| Rectangle | R | two corners. Type `5,4` for an exact size |
| Rotated Rectangle | | one side, then the other |
| Circle | C | center, then radius. Type a number of sides, like `24s` |
| Polygon | N | center, then a corner |
| 2-Point Arc | A | the two ends, then the bulge |
| Arc (center) / 3-Point Arc / Pie | | from the tool bar or Shift+S |
| Freehand | | drag to draw; close it for a face |

Lines that cross a face split it; lines that meet make faces on their own.
That's how you cut a door outline into a wall: draw it on the wall, then
push it in.

## Exact sizes: just type

While a tool is running, type the size and press Enter. It goes in the
**Value** box at the bottom right.

- Lengths in any unit: `2.5`, `250cm`, `8'6"`, `12'`, `90mm`. The model's
  units are under **Document › Units**.
- Rectangles: `width,depth`.
- Copies (after a Move with Option/Ctrl): `x5` makes five more in a row, `/5`
  fills the gap with five.

## Snapping (inference)

SketchCraft shows what the cursor is locked to, with a colored dot and a label:

| Dot | Means |
| --- | --- |
| green | **Endpoint** of an edge |
| green ring | **Center** of an arc or circle |
| blue | **Midpoint** of an edge |
| yellow square | the **Origin** |
| red | **On Edge** |
| blue diamond | **On Face** |
| a red, green or blue line | along an **axis** |

Hover a point, then move away: a dotted line shows when you're lined up with
it ("From Point"). Hover two points and move to where their lines cross: both
dotted lines show and the cursor lands on the crossing ("From Points"). That
finds the middle of a board or a floor: hover the midpoints of two sides that
meet, then move toward the middle. Press an **arrow key** to lock an axis:
→ red, ← green, ↑ blue. **Shift** holds whatever you're locked to.

## Guides and measuring

- **Tape Measure** (T): measures, and clicking an edge then pulling out leaves
  a guide line. Type a distance for an exact offset.
- **Protractor**: an angled guide.
- **Dimension** (D): click, click, pull out. **Text** (W): a label with a leader.

Next: [Shaping](03-shaping.md)
