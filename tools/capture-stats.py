#!/usr/bin/env python3
"""What a capture run gave: holes per request, how they ended, calls and tokens.

    python3 tools/capture-stats.py capture/<run> [capture/<run> ...]

Reads <run>/<label>/asks.jsonl (written by vera-probe-dynamic's tools/vera-harness/agent-run.js).
"""
import collections
import glob
import json
import os
import sys


def main(runs):
    requests = 0
    with_hole = 0
    outcomes = collections.Counter()
    calls = collections.Counter()
    tokens_in = tokens_out = cached = 0
    finishes = collections.Counter()
    per_family = collections.defaultdict(lambda: [0, 0])
    for run in runs:
        for path in sorted(glob.glob(os.path.join(run, '*', 'asks.jsonl'))):
            requests += 1
            label = os.path.basename(os.path.dirname(path))
            family = label.rsplit('-', 1)[0]
            events = [json.loads(line) for line in open(path, encoding='utf-8') if line.strip()]
            holes = [e for e in events if e['kind'] == 'hole']
            asks = [e for e in events if e['kind'] == 'ask']
            per_family[family][0] += 1
            per_family[family][1] += len(holes) + sum(1 for a in asks if a['task'] == 'catalogue-hole')
            if holes or any(a['task'] == 'catalogue-hole' for a in asks):
                with_hole += 1
            for h in holes:
                outcomes[('whole ' if h.get('whole') else 'section ') + h.get('outcome', '?')] += 1
            for a in asks:
                calls[a['task']] += 1
                finishes[a.get('finish')] += 1
                u = a.get('usage') or {}
                tokens_in += u.get('prompt_tokens', 0)
                tokens_out += u.get('completion_tokens', 0)
                cached += u.get('prompt_cache_hit_tokens', 0)
    print(f'requests {requests}, with a hole {with_hole} ({with_hole / max(requests, 1):.0%})')
    print('holes:', dict(outcomes))
    print('calls:', dict(calls), 'finish:', dict(finishes))
    print(f'tokens in {tokens_in} (cached {cached}), out {tokens_out}')
    print('holes per family:', {f: f'{h}/{n}' for f, (n, h) in sorted(per_family.items())})


if __name__ == '__main__':
    main(sys.argv[1:])
