#!/usr/bin/env python3
"""Read training examples as a person: the request each one sends, with the long parts (programs, phone functions,
the old section) cut to a marker, and optionally the answer. The system prompt is left out unless asked for.

    python3 tools/show.py data/v1/train.jsonl [--task section-edit] [--turn refine] [--family quiz] [-n 5] [--answer] [--system]
"""
import argparse
import gzip
import json
import random
import re

CUTS = [
    # (what to find, what to keep around it)
    (r'(The program so far, which the section joins \(do not repeat it\):\n)[\s\S]*?(?=\n\nYour section|\Z)', r'\1<... программа ...>'),
    (r'(The program:\n)[\s\S]*?(?=\n\nIt was made for:)', r'\1<... программа ...>'),
    (r'(Phone functions found[^\n]*\n)[\s\S]*?(?=\n\nThe section as|\n\nThe program so far|\n\nThe program has nothing)', r'\1<... найденные функции телефона ...>'),
    (r'(The section as it is now[^\n]*\n)[\s\S]*?(?=\n\nThe program so far)', r'\1<... старая секция ...>'),
    (r'(Your section was:\n|Your section:\n)[\s\S]*?(?=\n\nIt failed:)', r'\1<... прошлый ответ ...>'),
    (r'(SDK functions found for this request \(use only these\):\n)[\s\S]*?(?=\n\nRequest:)', r'\1<... найденные функции ...>'),
]


def cut(text):
    for pattern, keep in CUTS:
        text = re.sub(pattern, keep, text)
    # A program repair quotes the whole failed program first: keep its head.
    if text.startswith('import ') or text.startswith('@jsonable'):
        lines = text.split('\n')
        text = '\n'.join(lines[:3]) + '\n<... программа ...>\n' + '\n'.join(l for l in lines if l.strip() and not l.startswith(' ') and
                                                                        not l.startswith('}') and ('fail' in l.lower() or 'error' in l.lower() or 'change' in l.lower()))
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--task')
    ap.add_argument('--turn')
    ap.add_argument('--family')
    ap.add_argument('-n', type=int, default=5)
    ap.add_argument('--answer', action='store_true')
    ap.add_argument('--system', action='store_true')
    ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    opener = gzip.open if a.file.endswith('.gz') else open
    rows = [json.loads(l) for l in opener(a.file, 'rt', encoding='utf-8')]
    rows = [r for r in rows if (not a.task or r['metadata']['task'] == a.task) and (not a.turn or r['metadata']['turn'] == a.turn)
            and (not a.family or r['metadata']['family'] == a.family)]
    random.Random(a.seed).shuffle(rows)
    print(f'{len(rows)} examples match; showing {min(a.n, len(rows))}\n')
    for r in rows[:a.n]:
        m = r['metadata']
        print('=' * 100)
        print(f"{m['task']} / {m['turn']}   family={m['family']}   label={m.get('label')}" + (f"   change={m['change']!r}" if m.get('change') else ''))
        if a.system:
            print('--- SYSTEM ---\n' + r['messages'][0]['content'])
        print('--- USER ---\n' + cut(r['messages'][1]['content']))
        if a.answer:
            print('--- ANSWER ---\n' + r['messages'][2]['content'])
        print()


if __name__ == '__main__':
    main()
