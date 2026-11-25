#!/bin/bash
# The model trained on a Mac with Apple Silicon (MLX), from the examples in data/v1 to a q4_k_m GGUF the phone loads.
#
#   train/mac.sh                        # everything: setup, data, training, GGUF
#   NAME=try MAX_LEN=8192 train/mac.sh  # a Mac with 16 GB: the longest examples left out
#   STEP=gguf train/mac.sh              # only the last step again (after a finished training)
#
# Needs macOS on arm64, python3 >= 3.10 and Homebrew (for llama.cpp). The base model comes from the Hugging Face hub on the
# first run (MODEL, ~1 GB). Everything goes to runs/$NAME/ (git-ignored): data/ and config.yaml (train/to_mlx.py),
# weights/ (mlx_lm, saved as it trains), final/ (the fused model), model-f16.gguf and model-q4_k_m.gguf.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${NAME:-mlx-v1}
MODEL=${MODEL:-Qwen/Qwen2.5-Coder-0.5B-Instruct}
MAX_LEN=${MAX_LEN:-16384}
EPOCHS=${EPOCHS:-2}
LR=${LR:-1e-5}
STEP=${STEP:-all}
OUT=runs/$NAME
LLAMA_TAG=b10358  # the llama.cpp release whose convert_hf_to_gguf.py made this repo's GGUF on Linux

[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "This is for a Mac with Apple Silicon; on Linux with a GPU use train/run.sh"; exit 1; }
if [ ! -x .venv-mac/bin/python ]; then
  python3 -m venv .venv-mac
  .venv-mac/bin/pip install -q --upgrade pip
  .venv-mac/bin/pip install -q -r train/requirements-mac.txt
fi
PY=.venv-mac/bin/python

if [ "$STEP" = all ]; then
  for s in train validation test; do [ -f data/v1/$s.jsonl ] || gunzip -k data/v1/$s.jsonl.gz; done
  $PY train/to_mlx.py --model "$MODEL" --data data/v1 --out "$OUT" --max-len "$MAX_LEN" --epochs "$EPOCHS" --lr "$LR"
  # The training saves its weights every so often; run it again with the same NAME to start over.
  $PY -m mlx_lm lora -c "$OUT/config.yaml" 2>&1 | tee "$OUT/train.log"
  $PY -m mlx_lm fuse --model "$MODEL" --adapter-path "$OUT/weights" --save-path "$OUT/final"
fi

# GGUF: llama.cpp's converter (from the tagged release) and llama-quantize (Homebrew).
command -v llama-quantize >/dev/null || brew install llama.cpp
if [ ! -f runs/llama.cpp/convert_hf_to_gguf.py ]; then
  git clone -q --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp runs/llama.cpp
fi
PYTHONPATH=runs/llama.cpp/gguf-py $PY runs/llama.cpp/convert_hf_to_gguf.py "$OUT/final" --outtype f16 --outfile "$OUT/model-f16.gguf"
llama-quantize "$OUT/model-f16.gguf" "$OUT/model-q4_k_m.gguf" q4_k_m
ls -la "$OUT"/*.gguf
echo "Done: $OUT/model-q4_k_m.gguf"
