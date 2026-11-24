#!/usr/bin/env node
// Training examples from capture runs: only the hole writers' replies the app kept, in chat form.
//
//   node tools/export.js -o data/<name> capture/<run> [capture/<run> ...]
//
// Each run is what vera-probe-dynamic's tools/vera-harness/agent-run.js wrote: <run>/language.txt and
// <run>/<label>/asks.jsonl, where `ask` events are the calls in the order they were made and `hole` events say how the
// calls before them ended. A section is kept when its hole was written (every need done, not the whole screen) and is
// not a scene: the kept reply is the last call before the hole event. Its turn is `repair` when the request it answered
// quotes an earlier failure. A hole reported as not possible goes to review.jsonl, to be read before it is trained on.
//
// The system prompt is shortened: the language (the skill with the catalogue, <run>/language.txt) is cut from its
// front, leaving the section contract and its rules. The phone must send the local model exactly that.
//
// Families come from prompts/batches/*.tsv (family<TAB>label<TAB>prompt); the split is a fixed hash of the family.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const args = process.argv.slice(2)
const outAt = args.indexOf('-o')
if (outAt < 0 || args.length < outAt + 2) { console.error('usage: export.js -o OUTDIR RUN [RUN ...]'); process.exit(2) }
const out = args[outAt + 1]
const runs = args.filter((_, i) => i !== outAt && i !== outAt + 1)
const root = path.join(__dirname, '..')

const TEACHER = 'deepseek-flash'
const FAILED_MARK = '\n\nIt failed:\n'
const SCENE = /\bui\.(Surface|World)\s*\(/

/** label -> family, from every batch file. */
function families() {
  const map = new Map()
  const dir = path.join(root, 'prompts', 'batches')
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.tsv')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue
      const [family, label] = line.split('\t')
      map.set(label, family)
    }
  }
  return map
}

/** train / validation / test from the family alone, so no family is on two sides. */
function splitOf(family) {
  const bucket = parseInt(crypto.createHash('sha256').update(family).digest('hex').slice(0, 8), 16) % 1000
  return bucket < 850 ? 'train' : bucket < 925 ? 'validation' : 'test'
}

function between(text, tag) {
  const open = text.indexOf('<' + tag + '>')
  const close = text.indexOf('</' + tag + '>')
  return open < 0 || close < open ? null : text.slice(open + tag.length + 2, close)
}

/** Whether a whole-form reply is the section the hole record kept: every line of its functions is in the record's code. */
function matchesRecord(reply, code) {
  const functions = between(reply, 'functions')
  if (functions === null) return true // SEARCH/REPLACE edits: the record holds the section they made, not their text
  const kept = new Set(code.split('\n').map(l => l.trim()))
  return functions.split('\n').map(l => l.trim()).filter(Boolean).every(l => kept.has(l))
}

function main() {
  const familyOf = families()
  const rows = {train: [], validation: [], test: []}
  const review = []
  const seen = new Set()
  const stats = {requests: 0, holes: 0, kept: {first: 0, repair: 0}, dropped: {}, bySplit: {}, byFamily: {}}
  const drop = why => { stats.dropped[why] = (stats.dropped[why] || 0) + 1 }
  for (const run of runs) {
    const language = fs.readFileSync(path.join(run, 'language.txt'), 'utf8')
    for (const label of fs.readdirSync(run).sort()) {
      const file = path.join(run, label, 'asks.jsonl')
      if (!fs.existsSync(file)) continue
      stats.requests++
      const family = familyOf.get(label)
      if (!family) { drop('label in no batch file'); continue }
      const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      let group = []
      for (const e of events) {
        if (e.kind === 'ask' && e.task === 'section') { group.push(e); continue }
        if (e.kind !== 'hole') continue
        stats.holes++
        const asks = group
        group = []
        const last = asks[asks.length - 1]
        if (!last) { drop('hole with no call (known from an earlier hole)'); continue }
        if (e.whole) { drop('whole screen'); continue }
        // A hole reported because every try failed is not a refusal: its `why` is the failure, which starts 'custom section'.
        if (e.outcome === 'reported' && e.why && e.why.startsWith('custom section')) { drop('reported: failed'); continue }
        if (e.outcome === 'reported' && e.why) {
          review.push({label, family, prompt: e.prompt, needs: e.needs, why: e.why, reply: last.reply})
          drop('reported: to review')
          continue
        }
        if (e.outcome !== 'written') { drop(e.outcome); continue }
        if ((e.missed || []).length > 0) { drop('missed needs'); continue }
        if (last.error || last.finish !== 'stop') { drop('not finished'); continue }
        if (SCENE.test(last.reply)) { drop('scene'); continue }
        if (!last.system.startsWith(language)) { drop('system prompt without the language'); continue }
        if (!matchesRecord(last.reply, e.code || '')) { drop('reply is not the section kept'); continue }
        const system = last.system.slice(language.length).trimStart()
        const key = crypto.createHash('sha256').update(system + '\u0000' + last.user).digest('hex')
        if (seen.has(key)) { drop('duplicate request'); continue }
        seen.add(key)
        const turn = last.user.includes(FAILED_MARK) ? 'repair' : 'first'
        const split = splitOf(family)
        rows[split].push({
          messages: [{role: 'system', content: system}, {role: 'user', content: last.user}, {role: 'assistant', content: last.reply}],
          metadata: {task: 'section', turn, family, label, split, run: path.basename(run), needs: e.needs,
            calls: asks.length, declines: (last.reply.match(/<cannot\s+need=/g) || []).length,
            phoneCalls: (last.reply.match(/sdk\.call\(/g) || []).length, teacher: last.model || TEACHER,
            usage: last.usage || null, checks: ['compiled', 'smoke run', 'targets found', 'Jev']},
        })
        stats.kept[turn]++
        stats.bySplit[split] = (stats.bySplit[split] || 0) + 1
        stats.byFamily[family] = (stats.byFamily[family] || 0) + 1
      }
    }
  }
  fs.mkdirSync(out, {recursive: true})
  for (const [split, list] of Object.entries(rows)) {
    fs.writeFileSync(path.join(out, split + '.jsonl'), list.map(r => JSON.stringify(r) + '\n').join(''))
  }
  fs.writeFileSync(path.join(out, 'review.jsonl'), review.map(r => JSON.stringify(r) + '\n').join(''))
  stats.runs = runs.map(r => path.basename(r))
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1) + '\n')
  console.log(JSON.stringify(stats))
}

main()
