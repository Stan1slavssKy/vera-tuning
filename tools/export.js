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
/** The system prompt of a program edit once the language is cut from it: the one line the phone sends a local model. */
const EDIT_SYSTEM = 'You change a VERA-L program as the person asks.'

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
  // 80/10/10 by topic: at 85/7.5/7.5 the first 33 topics left validation empty.
  return bucket < 800 ? 'train' : bucket < 900 ? 'validation' : 'test'
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

const ASK_TARGET = 'Vera.Ask.text'
const targetsIn = text => [...text.matchAll(/sdk\.call\(\s*"([^"]+)"/g)].map(m => m[1])

/** The second judge's word on one route of a refine (tools/rejudge.js writes it into the asks as a `judge` event). */
const judgeOf = (events, route) => events.find(e => e.kind === 'judge' && e.route === route) || null

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
    // Scenes are not in v1: neither a scene written nor anything written into a program that has one (its prompt
    // carries the scene guide).
    if (SCENE.test(reply) || SCENE.test(user)) { drop(metadata.task + ': scene in the program'); return }
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
  /**
   * Refines of a built screen (agent-run.js --refine): each change made by edits of the whole program and by the written
   * section changed. A way is kept when it passed its checks and Jev reads it as making the change. Edits that served
   * with no repair round are kept as the change's answer; after a repair, the repair that mended them is kept instead.
   */
  const refines = (events, family, label, run, language) => {
    for (const route of ['program', 'section']) {
      const task = route + '-edit'
      const asks = events.filter(e => e.kind === 'ask' && e.task === task)
      const edit = events.find(e => e.kind === 'edit' && e.route === route)
      if (!edit) continue
      stats.holes++
      const last0 = asks[asks.length - 1]
      // A change no phone app can make (agent-run --impossible): the right answer is a refusal, read before it is trained on;
      // one that "made" it faked it.
      if (edit.impossible) {
        const refused = edit.cannot || (edit.declined || []).length > 0
        if (refused && last0 && language !== null && last0.system.startsWith(language) && !SCENE.test(last0.reply)) {
          const system = last0.system.slice(language.length).trimStart() || EDIT_SYSTEM
          const verdict = verdictOf.get(label + ' ' + edit.change) || 'unread'
          if (verdict === 'accept') {
            keep(family, system, last0.user, last0.reply, {task, turn: 'refine-decline', label, run: path.basename(run), change: edit.change,
              calls: asks.length, teacher: last0.model || TEACHER, usage: last0.usage || null, checks: ['refusal read']})
          } else {
            review.push({kind: 'impossible change', verdict, key: label + ' ' + edit.change, label, family, route, change: edit.change,
              cannot: edit.cannot || '', declined: edit.declined || [],
              messages: [{role: 'system', content: system}, {role: 'user', content: last0.user}, {role: 'assistant', content: last0.reply}]})
            drop(task + ': impossible, refused: ' + verdict)
          }
        } else drop(task + ': impossible, ' + (edit.ok ? 'faked' : 'failed'))
        continue
      }
      if (!edit.ok) { drop(task + ': ' + (edit.cannot ? 'declined' : 'failed')); continue }
      // Jev reads edits as lines taken out and put in, and often misses a change they make: a second judge
      // (tools/rejudge.js, judge.json beside the asks) settles those it did not read.
      const judged = judgeOf(events, route)
      if (!edit.does && !(judged && judged.done)) { drop(task + ': Jev does not read the change' + (judged ? ', nor the judge' : '')); continue }
      // Edits of the whole program are shown no phone functions: a target the program did not call before is made up
      // (one wrote sdk.call("system.clipboard", ...)), and the compiler does not check targets.
      if (route === 'program') {
        // The program the edits were made to: the built screen, or in a chain the one the change before left.
        const base = edit.base !== undefined ? edit.base :
          (fs.existsSync(path.join(run, label, 'program.vera')) ? fs.readFileSync(path.join(run, label, 'program.vera'), 'utf8') : '')
        const before = new Set(targetsIn(base))
        const added = targetsIn(edit.source || '').filter(t => !before.has(t) && t !== ASK_TARGET)
        if (added.length > 0) { drop(task + ': calls a target the program did not'); continue }
      }
      const last = asks[asks.length - 1]
      if (!last || last.error || last.finish !== 'stop') { drop(task + ': not finished'); continue }
      if (language === null || !last.system.startsWith(language)) { drop(task + ': system prompt without the language'); continue }
      if (SCENE.test(last.reply)) { drop(task + ': scene'); continue }
      // The program's edits are asked with the language alone: with it cut, the request carries the rules.
      const system = last.system.slice(language.length).trimStart() || EDIT_SYSTEM
      // A program's served edits came from a repair when it took repair rounds; a section's, when its request quotes a failure.
      // A program's served edits answer the change itself unless the last call was a repair: a second try, thinking,
      // asks the change again after a first one that could not be mended.
      const repaired = route === 'program' ? !(last.user.startsWith('The program:\n') && last.user.includes('\n\nThe change asked for now: ')) :
        last.user.includes(FAILED_MARK)
      const turn = repaired ? 'refine-repair' : 'refine'
      keep(family, system, last.user, last.reply, {task, turn, label, run: path.basename(run), change: edit.change, depth: edit.depth || 0,
        calls: asks.length, edits: edit.edits ?? null, rounds: edit.rounds ?? null, teacher: last.model || TEACHER, usage: last.usage || null,
        checks: ['compiled', 'smoke run', 'Jev reads the change'].concat(route === 'section' ? ['targets found'] : [])})
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
      const refineDir = path.join(run, label, 'refine')
      if (fs.existsSync(refineDir)) {
        // "0", "1", ... a change on the screen as built; "0.1", "0.1.2" the changes after it in a chain (agent-run --chain).
        for (const k of fs.readdirSync(refineDir).filter(d => /^\d+(\.\d+)*$/.test(d)).sort()) {
          const refineFile = path.join(refineDir, k, 'asks.jsonl')
          if (fs.existsSync(refineFile)) refines(fs.readFileSync(refineFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), family, label, run, language)
        }
      }
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
  stats.familiesBySplit = {}
  for (const f of Object.keys(stats.byFamily).sort()) (stats.familiesBySplit[splitOf(f)] = stats.familiesBySplit[splitOf(f)] || []).push(f)
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1) + '\n')
  console.log(JSON.stringify(stats))
}

main()
