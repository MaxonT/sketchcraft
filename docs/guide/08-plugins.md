# 8. Plugins

![The Shelves and Cut list plugins](../demos/shelves-cut-list.gif)

Plugins add commands to SketchCraft. Find them in **File › Plugins ▸** or by
name in **Shift+S**.

## Built in

- **Cut list:** select the boards (each its own group or component), or select
  nothing for the whole model. It lists every part to cut, grouped by size and
  material, and roughly how many 4×8 sheets and 8-foot boards to buy. Boards
  that are real dimensional lumber show by name (2×4, 1×6, 4×4…), and every
  board line has its board feet, with a total. Copy the table or save it as CSV.
- **Shelf unit:** a bookcase from a few sizes, every board its own group, ready
  for the cut list.

## Adding and managing plugins

**File › Plugins ▸ Manage plugins…** lists them all. Turn each on or off,
remove ones you added (they're moved aside, not deleted), and **Install from
file…** to add a plugin someone sent you as a `.zip`.

## SketchUp Ruby scripts

Many SketchUp extensions that **build** things (stairs, framing, fences,
shelves, houses) run in SketchCraft. Install the `.rbz` (or `.rb`) with
**Install from file…**; its menu items appear in **File › Plugins**. Input boxes
become SketchCraft forms, and what the script builds can be undone.

Extensions that need SketchUp's own windows, mouse tools or files won't run
yet; they stop with a message saying what's missing.
[What works](../dev/sketchup-ruby.md).

## Are plugins safe?

They run in a sandbox: no internet, no access to your files, no way to run other programs, and a minute at
most. SketchUp Ruby scripts run in the same sandbox. They can change your model, and **⌘Z** undoes that like anything else.

## Write your own

A plugin is a little JavaScript. See [Writing a plugin](../PLUGINS.md).

Next: [Keyboard shortcuts](09-shortcuts.md)
