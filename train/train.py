#!/usr/bin/env python3
"""Full fine-tune of Qwen2.5-Coder-0.5B-Instruct on the prepared examples (train/prepare.py): the loss on each answer
alone, examples of a like length batched together, the validation loss every --eval-steps, the best kept.

    .venv/bin/python train/train.py --model MODEL_DIR --prep runs/prep --out runs/sft-v1 [--epochs 2] [--lr 1e-5]
    # a smoke run on a CPU: --limit 16 --max-len 1024 --max-steps 4

On a GPU it trains in bf16 with gradient checkpointing; on a CPU in fp32, for checking that it runs.
"""
import argparse
import json
import math
import os

import torch
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments


class Prepared(Dataset):
    def __init__(self, path, max_len, limit):
        self.rows = []
        for line in open(path, encoding='utf-8'):
            r = json.loads(line)
            if len(r['input_ids']) <= max_len:
                self.rows.append({'input_ids': r['input_ids'], 'labels': r['labels']})
            if limit and len(self.rows) >= limit:
                break

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return self.rows[i]


def collate(pad_id):
    def go(batch):
        n = max(len(b['input_ids']) for b in batch)
        ids = torch.full((len(batch), n), pad_id, dtype=torch.long)
        labels = torch.full((len(batch), n), -100, dtype=torch.long)
        mask = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            k = len(b['input_ids'])
            ids[i, :k] = torch.tensor(b['input_ids'])
            labels[i, :k] = torch.tensor(b['labels'])
            mask[i, :k] = 1
        return {'input_ids': ids, 'labels': labels, 'attention_mask': mask}
    return go


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--prep', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=float, default=2)
    ap.add_argument('--lr', type=float, default=1e-5)
    ap.add_argument('--batch', type=int, default=1, help='examples per device step')
    ap.add_argument('--accum', type=int, default=16, help='steps per optimizer update')
    ap.add_argument('--max-len', type=int, default=16384)
    ap.add_argument('--eval-steps', type=int, default=100)
    ap.add_argument('--max-steps', type=int, default=-1)
    ap.add_argument('--limit', type=int, default=0, help='examples per split, for a smoke run')
    a = ap.parse_args()

    gpu = torch.cuda.is_available()
    tok = AutoTokenizer.from_pretrained(a.model)
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16 if gpu else torch.float32,
                                                 attn_implementation='sdpa')
    train = Prepared(os.path.join(a.prep, 'train.jsonl'), a.max_len, a.limit)
    val = Prepared(os.path.join(a.prep, 'validation.jsonl'), a.max_len, a.limit)
    steps = math.ceil(len(train) / (a.batch * a.accum) * a.epochs)
    print(f'{len(train)} train, {len(val)} validation examples; about {steps} updates; device {"cuda" if gpu else "cpu"}')

    args = TrainingArguments(
        output_dir=a.out, num_train_epochs=a.epochs, max_steps=a.max_steps, learning_rate=a.lr,
        lr_scheduler_type='cosine', warmup_steps=0.03, weight_decay=0.0,
        per_device_train_batch_size=a.batch, per_device_eval_batch_size=a.batch, gradient_accumulation_steps=a.accum,
        train_sampling_strategy='group_by_length', length_column_name='input_ids',
        bf16=gpu, gradient_checkpointing=gpu, logging_steps=10 if a.max_steps < 0 else 1,
        eval_strategy='steps', eval_steps=a.eval_steps if a.max_steps < 0 else max(1, a.max_steps),
        save_strategy='steps', save_steps=a.eval_steps if a.max_steps < 0 else max(1, a.max_steps), save_total_limit=2,
        load_best_model_at_end=True, metric_for_best_model='eval_loss', greater_is_better=False,
        report_to=[], dataloader_num_workers=2 if gpu else 0, remove_unused_columns=False, seed=7)
    trainer = Trainer(model=model, args=args, train_dataset=train, eval_dataset=val,
                      data_collator=collate(tok.pad_token_id), processing_class=tok)
    trainer.train()
    final = os.path.join(a.out, 'final')
    trainer.save_model(final)
    tok.save_pretrained(final)
    print('saved', final, 'eval', trainer.evaluate())


if __name__ == '__main__':
    main()
