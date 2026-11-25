#!/usr/bin/env python3
"""Checks an exported dataset (tools/export.js) before it is trained on; exits 1 when a check that must hold fails.

    python3 tools/check-data.py data/v1

Must hold: every row is system/user/assistant with text (a chat row: its history, system first, the answer last); no request on two sides of the split; one system prompt per task; every
SEARCH part of an answer is found exactly once in what it edits; no phone target in an answer's new code that its request does not name. Printed: examples by task, turn
and split, and their length in tokens (chars / 3.23, the teacher's ratio on v1's answers).
"""
import collections
import json
import os
import re
import sys

EDIT = re.compile(r'<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE')
TARGET = re.compile(r'sdk\.call\(\s*"([^"]+)"')
CHARS_PER_TOKEN = 3.23


def edited_text(user, task):
    """What a reply's SEARCH parts are copied from, as tools/export.js's editedText reads it."""
    if task in ('program-edit', 'program-repair', 'program-rewrite'):
        m = re.match(r'The program:\n([\s\S]*?)\n\nIt was made for:', user)
        if m:
            return m.group(1)
        at = user.find('\n\nRequest: ')
        return user[:at] if at > 0 else None
    if '\n\nIt failed:\n' in user:
        m = re.search(r'(?:Your section was:\n|Your section:\n)([\s\S]*?)\n\nIt failed:', user)
        return m.group(1) if m else None
    m = re.search(r'The section as it is now[^\n]*\n([\s\S]*?)\n\nThe program so far', user)
    return m.group(1) if m else None


def main():
    root = sys.argv[1]
    rows = {}
    for split in ('train', 'validation', 'test'):
        path = os.path.join(root, split + '.jsonl')
        rows[split] = [json.loads(line) for line in open(path, encoding='utf-8')] if os.path.exists(path) else []
    failed = []

    def must(ok, what):
        if not ok:
            failed.append(what)

    every = [r for split in rows.values() for r in split]
    def bad_shape(r):
        roles = [m['role'] for m in r['messages']]
        if r['metadata']['task'] == 'chat':
            # The chat's whole history as the app sent it, its tool rounds included; the last is the answer.
            last = r['messages'][-1]
            return roles[0] != 'system' or roles[-1] != 'assistant' or not (last.get('content', '').strip() or last.get('tool_calls'))
        return roles != ['system', 'user', 'assistant'] or any(not m['content'].strip() for m in r['messages'])
    shape = sum(1 for r in every if bad_shape(r))
    must(shape == 0, f'{shape} rows not in their task\'s shape (system/user/assistant; a chat: system ... assistant)')

    users = {split: {json.dumps(r['messages'][:-1]) for r in rs} for split, rs in rows.items()}
    for held in ('validation', 'test'):
        both = len(users['train'] & users[held])
        must(both == 0, f'{both} requests both in train and {held}')

    systems = collections.defaultdict(set)
    for r in every:
        systems[r['metadata']['task']].add(r['messages'][0]['content'])
    for task, found in sorted(systems.items()):
        must(len(found) <= 1, f'{task}: {len(found)} system prompts')

    bad_edits = collections.Counter()
    invented = collections.Counter()
    for r in every:
        task = r['metadata']['task']
        if task == 'chat':
            continue
        user, reply = r['messages'][1]['content'], r['messages'][2]['content']
        blocks = EDIT.findall(reply)
        if blocks:
            text = edited_text(user, task)
            if text is not None:
                for search, _ in blocks:
                    if text.count(search) != 1:
                        bad_edits[task] += 1
            new = '\n'.join(replace for _, replace in blocks)
        else:
            new = reply
        for target in set(TARGET.findall(new)):
            if target not in user and target != 'Vera.Ask.text':
                invented[task] += 1
    must(not bad_edits, f'SEARCH parts not found exactly once: {dict(bad_edits)}')
    must(not invented, f'phone targets the request does not name: {dict(invented)}')

    print(f"{'task / turn':36s} {'train':>6s} {'val':>5s} {'test':>5s}   tokens p50 / p95 / max")
    by = collections.defaultdict(lambda: collections.Counter())
    lengths = collections.defaultdict(list)
    for split, rs in rows.items():
        for r in rs:
            m = r['metadata']
            by[m['task'] + ' / ' + m['turn']][split] += 1
            lengths[m['task'] + ' / ' + m['turn']].append(len(json.dumps(r['messages'] + r.get('tools', []), ensure_ascii=False)) / CHARS_PER_TOKEN)
    for key in sorted(by):
        c, ls = by[key], sorted(lengths[key])
        print(f"{key:36s} {c['train']:6d} {c['validation']:5d} {c['test']:5d}   "
              f"{ls[len(ls) // 2]:6.0f} / {ls[int(len(ls) * .95)]:6.0f} / {ls[-1]:6.0f}")
    total = {split: len(rs) for split, rs in rows.items()}
    print(f"{'all':36s} {total['train']:6d} {total['validation']:5d} {total['test']:5d}   = {sum(total.values())}")

    for what in failed:
        print('FAIL', what)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
