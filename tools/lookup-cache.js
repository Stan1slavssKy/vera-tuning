#!/usr/bin/env node
// The phone's function lookups, for the host to replay: every "lookup" event (VeraTiming.ets's traceLookup) of the traces
// given, as one JSON object keyed tool NUL query NUL both(1|0) -> the text the hole writer was shown.
//
//   node tools/lookup-cache.js -o lookups.json TRACE_OR_DIR [...]
//
// A directory is searched for trace.jsonl files (tools/vera-bench/bench.sh pulls one per run). When one query has two
// different answers (the index changed between runs), the later one wins and the count is printed.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const at = args.indexOf('-o')
if (at < 0) { console.error('usage: lookup-cache.js -o OUT TRACE_OR_DIR [...]'); process.exit(2) }
const out = args[at + 1]
const inputs = args.filter((_, i) => i !== at && i !== at + 1)

function traces(p) {
  if (fs.statSync(p).isFile()) return [p]
  return fs.readdirSync(p, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? traces(path.join(p, e.name)) : e.name === 'trace.jsonl' ? [path.join(p, e.name)] : [])
}

const cache = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {}
let added = 0
let changed = 0
for (const file of inputs.flatMap(traces).sort()) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"event":"lookup"')) continue
    let e
    try { e = JSON.parse(line) } catch (_) { continue }
    const key = e.tool + '\u0000' + e.query + '\u0000' + (e.both ? '1' : '0')
    if (!(key in cache)) added++
    else if (cache[key] !== e.text) changed++
    cache[key] = e.text
  }
}
fs.writeFileSync(out, JSON.stringify(cache) + '\n')
console.log(`lookups: ${Object.keys(cache).length} (${added} new, ${changed} changed)`)
