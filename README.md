# vera-tuning

Data and training for a local Qwen2.5-Coder-0.5B that fills VERA holes on the phone in place of DeepSeek.

## What the model is trained for

Exactly the requests the app sends, in exactly the form it parses. Three tasks, in this order:

1. **Catalogue holes** (`VeraHoles.ets` in vera-probe-dynamic): the body of a small function inside a section the
   composer already chose. The prompt comes from `buildHolePrompt` / `buildRepairPrompt`. The answer is
   `{"holes": {"<key>": "<body>"}}`, each body 600 characters at most. This is the first target.
2. **Section holes** (`agent/AgentCustom.ets`, `writeSection`): one section with `<classes>`, `<fields>`, `<functions>`
   and `<view>`, mended by SEARCH/REPLACE edits.
3. **The whole screen** (`agent/VeraBuildRoute.ets`, `writeWholeScreen`): when no part of the screen can be built from what
   is ready, the whole program as one section in the same form, asked of a program with nothing but its header, against
   the plan DeepSeek drew. Export task `whole-screen`, kept when an `agent-run.js -r` run writes it. Rare: 3 of 865
   requests reached it on the host, none of 40 on the phone, so it is not captured on purpose.

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

## Training

`train/run.sh` on a GPU machine: `train/prepare.py` renders each example with the base model's own chat template (Qwen2.5,
tools included; a tool call's arguments as an object), the loss on the last assistant message alone, examples over 16384
tokens left out, never cut; `train/train.py` is a full fine-tune (bf16, gradient checkpointing, examples of a like length
batched, 2 epochs at 1e-5, 16 examples an update, the best validation loss kept); then GGUF f16 and q4_k_m by llama.cpp.
The same runs on a CPU at a small size to check the chain: `train/train.py --limit 16 --max-len 1024 --max-steps 4`.

On a Mac with Apple Silicon: `train/mac.sh`, one command from a fresh clone to `runs/mlx-v1/model-q4_k_m.gguf`. It sets up
`.venv-mac` (`train/requirements-mac.txt`), writes the data and config for MLX (`train/to_mlx.py`: the same template,
mask and length rule, a full fine-tune, 2 epochs at 1e-5, 16 examples an update, a cosine schedule), trains with
`mlx_lm lora`, fuses, and makes the GGUF with llama.cpp (Homebrew's `llama-quantize`, the converter of tag b10358). On a
16 GB Mac: `MAX_LEN=8192 train/mac.sh` leaves the longest examples out. The data conversion and config were checked on
Linux; the MLX training itself first runs on the Mac.

## How a model is judged

On held-out requests through the app's own checks, next to DeepSeek: share that compile, pass the smoke run and Jev,
repairs per hole, invented targets (must be 0). Loss alone says little.
