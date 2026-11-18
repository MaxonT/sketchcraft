# minimodel spike

Can a small local model (offline, no accounts, no API keys, no cloud) turn plain English into SketchCraft
commands? This folder measures it. Results and the plan: [docs/dev/minimodel-spike.md](../../docs/dev/minimodel-spike.md).

Nothing here ships in the app. It needs Node 20+, a built `sketchcraft` binary and (for real models) Ollama.

## What is here

| Path | What |
| --- | --- |
| `eval/cases.jsonl` | 201 requests: easy / medium / hard, 45 of them also tagged `"cat":"a11y"` (see below) |
| `eval/fixtures/*.jsonl` | starting models (a house group, a room, two cubes...). A case with `"fixture"` runs it first; its `# ...` header line is what the model is told about the model state |
| `eval/build_cases.mjs` | the single source: `node eval/build_cases.mjs` regenerates `cases.jsonl`, `fixtures/` and `fixtures.json` |
| `lib/check.mjs` | the result checks (bounding box, sizes, group/instance counts, faces, paint colors, tags, replies) |
| `lib/engine.mjs` | drives the real engine as an AI agent does: `sketchcraft mcp` (the untrusted allowlist), scratch `SKETCHCRAFT_DOC` and `HOME` per request |
| `lib/spec.mjs` | the command table the model may use (35 of ~170 commands): generates the prompt reference AND the JSON schema given to Ollama |
| `run_eval.mjs` | the harness |
| `validate_eval.mjs` | runs every case's reference solution through its own check: proves the checks are satisfiable and not too loose |
| `report.mjs` | `results/*.json` to markdown tables / failure examples |
| `run_all.sh` | one model at a time: pull, run three configurations, `ollama rm` |
| `results/` | raw per-request results from the runs in the doc |

## Run it

```sh
cargo build --release -p sketchcraft-core            # the engine; or point SKETCHCRAFT_BIN at an existing sketchcraft binary
export SKETCHCRAFT_BIN=target/release/sketchcraft
node tools/minimodel/validate_eval.mjs               # 201/201 gold solutions pass their checks
node tools/minimodel/run_eval.mjs --check-spec       # the command table still matches command.rs and the agent allowlist
node tools/minimodel/run_eval.mjs --model gold       # control: 100%
node tools/minimodel/run_eval.mjs --model noop       # control: a do-nothing answer (`info`) scores about 6%

ollama pull qwen2.5-coder:1.5b
node tools/minimodel/run_eval.mjs --model qwen2.5-coder:1.5b                    # schema-constrained (Ollama `format`)
node tools/minimodel/run_eval.mjs --model qwen2.5-coder:1.5b --mode free        # no grammar: parse whatever it writes
node tools/minimodel/run_eval.mjs --model qwen2.5-coder:1.5b --shots 3          # + 3 worked examples in the prompt
node tools/minimodel/report.mjs                                                 # tables
```

Useful flags: `--limit N` (an evenly spread subset), `--cat a11y`, `--ids e001,m010`, `--tag name`.
Env: `SKETCHCRAFT_BIN` (engine), `OLLAMA_HOST`, `MINIMODEL_SCRATCH` (where scratch folders go; default the OS temp dir; each
request's folder is deleted afterwards).

The harness waits while the Mac has under 30% memory free (`memory_pressure`), because small models and a build in
parallel do not fit in 8 GB; `--no-memory-guard` turns that off.

## How grading works

Each request is graded on the RESULT. The harness starts a fresh engine (scratch folder), runs the fixture, runs the model's
commands through the agent allowlist, then asks the engine for `info`, `parts` and `faces` and applies the case's `check`:
bounding box and sizes within a tolerance, group and instance counts, a face of a given area/normal/place, faces painted a
color class (red, blue...), tags, or a number in a reply (`volume`, `length`). Any correct command sequence passes; the gold
commands in `cases.jsonl` are only there to prove the check can be satisfied.

Questions ("how big is the room?") use `"check":{"readonly":true}`: pass = the model ran an inspect command (`info`, `parts`,
`faces`, `volume`, `pick`) and the model state is exactly as before.

Known limits of the checks: the position of an inserted door/window is not visible in `info`/`parts`, so those cases
check that it exists, not where (cases that need position use a group-built door or a cut-out opening instead); and a check
cannot tell that a model "meant" something, only that the result has the right numbers.

## The accessibility category (`"cat":"a11y"`)

45 requests written for people who dictate, type or use a switch/eye-tracker instead of pointing, and for screen-reader users:
precise numbers ("a wall 4.2 m long, 2.4 m high, 20 cm thick starting at the origin"), relative requests ("a window 1 m from the
left end of the north wall, 1.2 m wide"), edit-by-sentence follow-ups ("make it 5 meters instead", "move the door 1 m left",
"undo that") and read-only questions ("how big is the room?", "what's on the south wall?"). They are also graded
easy/medium/hard and counted in the tier totals; `run_eval` reports them separately too.
