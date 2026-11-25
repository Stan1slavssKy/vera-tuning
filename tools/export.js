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

/** label -> accept | reject | ask, from review/verdicts.tsv: a person's (or a reviewer's) word on a refusal. */
function verdicts() {
  const file = path.join(root, 'review', 'verdicts.tsv')
  const map = new Map()
  if (!fs.existsSync(file)) return map
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [label, verdict] = line.split('\t')
    map.set(label, verdict)
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

/** A body as the model writes it: cleanBody (VeraHoles.ets) indents every line by two spaces when it keeps it. */
function asWritten(body) {
  return body.split('\n').map(l => l.replace(/^ {2}/, '')).join('\n')
}

/** The needs a reply declines one by one, as written in <cannot need="..."> (HTML entities undone). */
function declinedIn(reply) {
  const entities = {quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", '#39': "'"}
  return [...reply.matchAll(/<cannot\s+need\s*=\s*"([^"]*)"\s*>/g)].map(m => m[1].replace(/&(quot|amp|lt|gt|apos|#39);/g, (_, e) => entities[e]))
}

/** A declined need names the need asked: the writer often copies only its start. */
const sameNeed = (declined, need) => declined.slice(0, 40) === need.slice(0, 40) || need.startsWith(declined) || declined.startsWith(need)

const sameBodies = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort())

function main() {
  const familyOf = families()
  const verdictOf = verdicts()
  const rows = {train: [], validation: [], test: []}
  const review = []
  const seen = new Set()
  const stats = {requests: 0, holes: 0, kept: {}, dropped: {}, bySplit: {}, byFamily: {}}
  const drop = why => { stats.dropped[why] = (stats.dropped[why] || 0) + 1 }
  const count = (table, key) => { table[key] = (table[key] || 0) + 1 }
  /** One example, unless the same request was already kept. */
  const keep = (family, system, user, reply, metadata) => {
    const key = crypto.createHash('sha256').update(system + '\u0000' + user).digest('hex')
    if (seen.has(key)) { drop('duplicate request'); return }
    seen.add(key)
    const split = splitOf(family)
    rows[split].push({messages: [{role: 'system', content: system}, {role: 'user', content: user}, {role: 'assistant', content: reply}],
      metadata: Object.assign({family, split}, metadata)})
    count(stats.kept, metadata.task + ' ' + metadata.turn)
    count(stats.bySplit, split)
    count(stats.byFamily, family)
  }
  /**
   * Catalogue holes, settled by the fill after their asks. The first request is answered with the bodies kept, whichever
   * try wrote them: they compiled and behaved, and a first answer that only needed `const` made `let` teaches the mistake.
   * A repair is kept as asked when its reply is what was kept.
   */
  const catalogueHole = (fill, asks, misses, family, label, run) => {
    stats.holes++
    if (misses > 0) return drop('catalogue hole: lookup not in the cache')
    if (Object.keys(fill.bodies || {}).length === 0) return drop('catalogue hole: nothing kept')
    if (fill.behaviour !== undefined && fill.behaviour !== 'ok') return drop('catalogue hole: ' + fill.behaviour.split(',')[0])
    const first = asks[0]
    if (first.error || first.finish !== 'stop') return drop('catalogue hole: not finished')
    const kept = Object.fromEntries(Object.entries(fill.bodies).map(([k, v]) => [k, asWritten(v)]))
    const meta = turn => ({task: 'catalogue-hole', turn, label, run: path.basename(run), hole: fill.hole || null,
      calls: asks.length, teacher: first.model || TEACHER, checks: fill.behaviour !== undefined ? ['compiled', 'behaviour', 'targets found'] : ['compiled']})
    keep(family, first.system, first.user, '{"holes": {' + Object.entries(kept).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}}', Object.assign(meta('first'),
      {source: sameBodies(first.parsed, fill.bodies) ? 'first try' : 'kept after repair'}))
    const repair = asks.slice(1).reverse().find(a => !a.error && a.finish === 'stop' && sameBodies(a.parsed, fill.bodies))
    if (repair) {
      const error = (repair.user.match(/"message": ("(?:[^"\\]|\\.)*")/) || [])[1]
      keep(family, repair.system, repair.user, repair.reply, Object.assign(meta('repair'), {error: error ? JSON.parse(error) : null}))
    }
  }
  for (const run of runs) {
    // Only the section writer is shown the language; a run of catalogue holes alone (hole-run.js) has none.
    const languageFile = path.join(run, 'language.txt')
    const language = fs.existsSync(languageFile) ? fs.readFileSync(languageFile, 'utf8') : null
    for (const label of fs.readdirSync(run).sort()) {
      const file = path.join(run, label, 'asks.jsonl')
      if (!fs.existsSync(file)) continue
      stats.requests++
      const family = familyOf.get(label)
      if (!family) { drop('label in no batch file'); continue }
      const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      let group = []
      let holeAsks = []
      let missed = 0
      for (const e of events) {
        if (e.kind === 'ask' && e.task === 'section') { group.push(e); continue }
        if (e.kind === 'ask' && e.task === 'catalogue-hole') { holeAsks.push(e); continue }
        // A phone lookup the replayed cache did not hold: the writer was shown nothing where the phone would show functions.
        if (e.kind === 'lookup' && !e.hit) { missed++; continue }
        if (e.kind === 'fill') {
          const asks = holeAsks
          holeAsks = []
          if (asks.length === 0) continue
          const misses = missed
          missed = 0
          catalogueHole(e, asks, misses, family, label, run)
          continue
        }
        if (e.kind !== 'hole') continue
        stats.holes++
        const asks = group
        const misses = missed
        group = []
        missed = 0
        if (misses > 0) { drop('lookup not in the cache'); continue }
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
        const unmet = e.missed || []
        const declined = declinedIn(last.reply)
        // Served with the needs it could not do declined in its own words (<cannot need>): a partial refusal, read by
        // a person before it is trained on (Jev reads what a section does, not whether a refusal is right).
        if (e.outcome === 'partial' && unmet.length > 0 && unmet.every(m => declined.some(d => sameNeed(d, m))) &&
            language !== null && last.system.startsWith(language) && last.finish === 'stop' && !SCENE.test(last.reply)) {
          const system = last.system.slice(language.length).trimStart()
          const verdict = verdictOf.get(label) || 'unread'
          if (verdict === 'accept') {
            keep(family, system, last.user, last.reply, {task: 'section', turn: 'decline', label, run: path.basename(run), needs: e.needs,
              declined: unmet, calls: asks.length, phoneCalls: (last.reply.match(/sdk\.call\(/g) || []).length,
              teacher: last.model || TEACHER, usage: last.usage || null, checks: ['compiled', 'smoke run', 'targets found', 'Jev', 'refusal read']})
            continue
          }
          review.push({kind: 'partial decline', verdict, label, family, prompt: e.prompt, needs: e.needs, missed: unmet,
            messages: [{role: 'system', content: system}, {role: 'user', content: last.user}, {role: 'assistant', content: last.reply}]})
          drop('partial decline: ' + verdict)
          continue
        }
        if (e.outcome !== 'written') { drop(e.outcome); continue }
        if (unmet.length > 0) { drop('missed needs'); continue }
        if (last.error || last.finish !== 'stop') { drop('not finished'); continue }
        if (SCENE.test(last.reply)) { drop('scene'); continue }
        if (language === null || !last.system.startsWith(language)) { drop('system prompt without the language'); continue }
        if (!matchesRecord(last.reply, e.code || '')) { drop('reply is not the section kept'); continue }
        const system = last.system.slice(language.length).trimStart()
        const turn = last.user.includes(FAILED_MARK) ? 'repair' : 'first'
        keep(family, system, last.user, last.reply, {task: 'section', turn, label, run: path.basename(run), needs: e.needs,
          calls: asks.length, declines: (last.reply.match(/<cannot\s+need=/g) || []).length,
          phoneCalls: (last.reply.match(/sdk\.call\(/g) || []).length, teacher: last.model || TEACHER,
          usage: last.usage || null, checks: ['compiled', 'smoke run', 'targets found', 'Jev']})
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
