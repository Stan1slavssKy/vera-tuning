#!/usr/bin/env python3
"""The exported examples (tools/export.js) as the model is trained on them: each rendered with the base model's own chat
template (Qwen2.5, tools included), tokenized, with the loss on the answer alone -- the last assistant message; every
token before it (system, request, history, tool results) is masked with -100.

    .venv/bin/python train/prepare.py --model MODEL_DIR --data data/v1 --out runs/prep [--max-len 16384]

Writes <out>/<split>.jsonl (input_ids, labels, task) and <out>/lengths.json; an example longer than --max-len is left
out and counted, never cut: a cut answer teaches an answer that stops in the middle.
"""
import argparse
import collections
import json
import os

from transformers import AutoTokenizer


def tool_calls_as_objects(messages):
    """Tool calls as Qwen writes them: arguments an object, not the JSON string the OpenAI-style API carries."""
    out = []
    for m in messages:
        m = dict(m)
        if m.get('tool_calls'):
            calls = []
            for c in m['tool_calls']:
                f = dict(c['function'])
                if isinstance(f.get('arguments'), str):
                    f['arguments'] = json.loads(f['arguments'])
                calls.append({'type': 'function', 'function': f})
            m['tool_calls'] = calls
            m['content'] = m.get('content') or ''
        out.append(m)
    return out


def render(tok, row):
    messages = tool_calls_as_objects(row['messages'])
    tools = row.get('tools') or None
    prompt = tok.apply_chat_template(messages[:-1], tools=tools, add_generation_prompt=True, tokenize=False)
    full = tok.apply_chat_template(messages, tools=tools, tokenize=False)
    if not full.startswith(prompt):
        raise ValueError('the template does not render the history the same with and without the answer')
    # The answer ends at its <|im_end|>; what the template adds after it (a newline) is not trained on.
    answer = full[len(prompt):]
    end = answer.find(tok.eos_token)
    answer = answer[:end + len(tok.eos_token)] if end >= 0 else answer + tok.eos_token
    p = tok(prompt, add_special_tokens=False)['input_ids']
    a = tok(answer, add_special_tokens=False)['input_ids']
    return p + a, [-100] * len(p) + a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--max-len', type=int, default=16384)
    a = ap.parse_args()
    tok = AutoTokenizer.from_pretrained(a.model)
    os.makedirs(a.out, exist_ok=True)
    report = {'max_len': a.max_len, 'splits': {}}
    for split in ('train', 'validation', 'test'):
        path = os.path.join(a.data, split + '.jsonl')
        if not os.path.exists(path):
            continue
        kept, too_long, by_task = 0, collections.Counter(), collections.defaultdict(list)
        tokens = answer_tokens = 0
        with open(os.path.join(a.out, split + '.jsonl'), 'w', encoding='utf-8') as f:
            for line in open(path, encoding='utf-8'):
                row = json.loads(line)
                task = row['metadata']['task'] + ' / ' + row['metadata']['turn']
                ids, labels = render(tok, row)
                by_task[task].append(len(ids))
                if len(ids) > a.max_len:
                    too_long[task] += 1
                    continue
                kept += 1
                tokens += len(ids)
                answer_tokens += sum(1 for x in labels if x != -100)
                f.write(json.dumps({'input_ids': ids, 'labels': labels, 'task': task}) + '\n')
        report['splits'][split] = {
            'kept': kept, 'too_long': dict(too_long), 'tokens': tokens, 'answer_tokens': answer_tokens,
            'by_task': {t: {'n': len(v), 'p50': sorted(v)[len(v) // 2], 'p95': sorted(v)[int(len(v) * .95)], 'max': max(v)}
                        for t, v in sorted(by_task.items())}}
        print(f"{split}: {kept} kept, {sum(too_long.values())} over {a.max_len} tokens, {tokens / 1e6:.1f}M tokens "
              f"({answer_tokens / 1e6:.2f}M trained on)")
    json.dump(report, open(os.path.join(a.out, 'lengths.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
