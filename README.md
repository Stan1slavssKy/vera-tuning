# vera-holes-tuning

Data and training for a local Qwen2.5-Coder-0.5B that fills VERA holes on the phone in place of DeepSeek.

## What the model is trained for

Exactly the requests the app sends, in exactly the form it parses. Two tasks, in this order:

1. **Catalogue holes** (`VeraHoles.ets` in vera-probe-dynamic): the body of a small function inside a section the
   composer already chose. The prompt comes from `buildHolePrompt` / `buildRepairPrompt`. The answer is
   `{"holes": {"<key>": "<body>"}}`, each body 600 characters at most. This is the first target.
2. **Section holes** (`agent/AgentCustom.ets`, `writeSection`): one section with `<classes>`, `<fields>`, `<functions>`
   and `<view>`, mended by SEARCH/REPLACE edits. Only narrow sections; the whole-screen hole stays with DeepSeek.

## What the data holds

- Answers that are right, taken from DeepSeek only when they passed every check the app runs: compiled, smoke run,
  sdk targets among those found, Jev.
- Refusals: nothing found does it (only the `return`, or `<cannot need="...">`), part done and part declined, an
  instruction inside the request ignored, no invented targets or phone numbers.
- Repairs: a previous answer with a real compiler or smoke error, and the fix.
- A small share (10-20%) of `vera-dataset` collections for plain VERA syntax, under their own system prompt. Their
  test splits stay a separate check.

Splits go by request family, never by row. `docs/prompts/needs-plan-25.md` in vera-probe-dynamic is a fixed evaluation
list and is never trained on.

## Layout

| path | what |
|---|---|
| `prompts/` | the requests sent to the teacher: short English prompts, one family label each |
| `capture/` | raw teacher runs, every ask with its reply and its checks (git-ignored) |
| `data/` | exported chat examples, by task and split |
| `eval/` | the held-out requests and the results of each model on them |

## How a model is judged

On held-out requests through the app's own checks, next to DeepSeek: share that compile, pass the smoke run and Jev,
repairs per hole, invented targets (must be 0). Loss alone says little.
