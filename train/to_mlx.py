#!/usr/bin/env python3
"""The exported examples (data/v1) as mlx_lm trains on them, and its config: train.jsonl / valid.jsonl / test.jsonl of
{"messages": [...], "tools": [...]} (a tool call's arguments as an object, as Qwen writes them), an example over
--max-len tokens of the base model's chat template left out (mlx_lm would cut it, and a cut answer teaches stopping in
the middle), and config.yaml: a full fine-tune with the loss on the last answer alone (mask_prompt), --epochs over the
train split, --accum examples an update, a cosine schedule with a short warmup.

    python train/to_mlx.py --model MODEL --data data/v1 --out runs/mlx-v1 [--max-len 16384] [--epochs 2] [--lr 1e-5]
"""
import argparse
import json
import math
import os
import re
import sys

from transformers import AutoTokenizer

sys.path.insert(0, os.path.dirname(__file__))
from prepare import tool_calls_as_objects  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-len', type=int, default=16384)
    ap.add_argument('--epochs', type=float, default=2)
    ap.add_argument('--lr', type=float, default=1e-5)
    ap.add_argument('--accum', type=int, default=16)
    ap.add_argument('--limit', type=int, default=0, help='examples per split, for a smoke run')
    a = ap.parse_args()
    tok = AutoTokenizer.from_pretrained(a.model)
    os.makedirs(os.path.join(a.out, 'data'), exist_ok=True)
    counts = {}
    for split, name in (('train', 'train'), ('validation', 'valid'), ('test', 'test')):
        kept = too_long = 0
        with open(os.path.join(a.out, 'data', name + '.jsonl'), 'w', encoding='utf-8') as f:
            for line in open(os.path.join(a.data, split + '.jsonl'), encoding='utf-8'):
                row = json.loads(line)
                example = {'messages': tool_calls_as_objects(row['messages'])}
                if row.get('tools'):
                    example['tools'] = row['tools']
                n = len(tok.apply_chat_template(example['messages'], tools=example.get('tools'), tokenize=True, return_dict=False))
                if n > a.max_len:
                    too_long += 1
                    continue
                f.write(json.dumps(example, ensure_ascii=False) + '\n')
                kept += 1
                if a.limit and kept >= a.limit:
                    break
        counts[split] = kept
        print(f'{name}: {kept} examples, {too_long} over {a.max_len} tokens left out')
    # mlx_lm counts an iteration per example (batch 1) and steps the schedule once an update (every --accum of them).
    iters = max(1, math.ceil(counts['train'] * a.epochs))
    updates = max(1, iters // a.accum)
    warmup = max(1, round(updates * 0.03))
    config = {
        'model': a.model, 'train': True, 'data': os.path.join(a.out, 'data'), 'fine_tune_type': 'full',
        'mask_prompt': True, 'batch_size': 1, 'grad_accumulation_steps': a.accum, 'iters': iters,
        'max_seq_length': a.max_len, 'grad_checkpoint': True, 'optimizer': 'adamw',
        'learning_rate': a.lr, 'lr_schedule': {'name': 'cosine_decay', 'warmup': warmup, 'arguments': [a.lr, max(1, updates - warmup)]},
        'steps_per_report': 20, 'steps_per_eval': max(20, iters // 20), 'val_batches': min(200, counts['validation']),
        'save_every': max(20, iters // 10), 'adapter_path': os.path.join(a.out, 'weights'), 'seed': 7,
    }
    # YAML is JSON's superset: written as JSON, read by mlx_lm's yaml loader -- but YAML reads 1e-05 as a string (a float
    # needs its dot there), so a number in exponent form is written out in full.
    text = json.dumps(config, indent=1)
    text = re.sub(r'(?<![\w.])(\d+(?:\.\d+)?)e(-?\d+)\b', lambda m: format(float(m.group(0)), 'f').rstrip('0').rstrip('.') + ('' if '.' in format(float(m.group(0)), 'f') else '.0'), text)
    with open(os.path.join(a.out, 'config.yaml'), 'w') as f:
        f.write(text + '\n')
    print(f'config: {iters} iterations, {updates} updates of {a.accum}, warmup {warmup}')


if __name__ == '__main__':
    main()
