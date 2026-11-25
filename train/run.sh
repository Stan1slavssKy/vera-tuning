#!/bin/bash
# On a GPU machine: the exported data (data/v1) to a q4_k_m GGUF the phone can load.
#
#   MODEL=Qwen/Qwen2.5-Coder-0.5B-Instruct LLAMA=~/llama.cpp train/run.sh [extra train.py flags]
#
# MODEL is a hub name or a local copy; LLAMA a llama.cpp checkout with build/bin/llama-quantize. Everything goes to
# runs/<name>/ (git-ignored): prep/ (tokenized, train/prepare.py), the checkpoints, final/, model-f16.gguf, model-q4_k_m.gguf.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL=${MODEL:-Qwen/Qwen2.5-Coder-0.5B-Instruct}
LLAMA=${LLAMA:?set LLAMA to a llama.cpp checkout}
NAME=${NAME:-sft-v1}
OUT=runs/$NAME
[ -x .venv/bin/python ] || { python3 -m venv .venv && .venv/bin/pip install -q -r train/requirements.txt; }
for s in train validation test; do [ -f data/v1/$s.jsonl ] || gunzip -k data/v1/$s.jsonl.gz; done
.venv/bin/python train/prepare.py --model "$MODEL" --data data/v1 --out $OUT/prep --max-len 16384
.venv/bin/python train/train.py --model "$MODEL" --prep $OUT/prep --out $OUT "$@"
PYTHONPATH=$LLAMA/gguf-py .venv/bin/python $LLAMA/convert_hf_to_gguf.py $OUT/final --outtype f16 --outfile $OUT/model-f16.gguf
$LLAMA/build/bin/llama-quantize $OUT/model-f16.gguf $OUT/model-q4_k_m.gguf q4_k_m
ls -la $OUT/*.gguf
