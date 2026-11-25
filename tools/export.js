#!/usr/bin/env node
// Training examples from capture runs: only the hole writers' replies the app kept, in chat form.
//
//   node tools/export.js -o data/<name> capture/<run> [capture/<run> ...]
//
// Each run is what vera-probe-dynamic's tools/vera-harness/agent-run.js wrote: <run>/language.txt and
// <run>/<label>/asks.jsonl, where `ask` events are the calls in the order they were made and `hole` events say how the
// calls before them ended. A section is kept when its hole was written (every need done) and is not a scene: the kept
// reply is the last call before the hole event. The whole screen as one hole (agent-run -r, --whole) is kept the same
// way as task `whole-screen`, when the screen served as written. Its turn is `repair` when the request it answered
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
/** The tasks of what a running program asks (runtime-run.js). */
const RUNTIME_TASKS = new Set(['source-find', 'live-read', 'ask-text'])
/** The system prompt of a program edit once the language is cut from it: the one line the phone sends a local model. */
const EDIT_SYSTEM = 'You change a VERA-L program as the person asks.'
/** The same for the whole program written again with a change (program-rewrite). */
const REWRITE_SYSTEM = 'You write a VERA-L program again, changed as the person asks.'

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
function verdicts(name = 'verdicts.tsv') {
  const file = path.join(root, 'review', name)
  const map = new Map()
  if (!fs.existsSync(file)) return map
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const [label, verdict] = line.split('\t')
    map.set(label, verdict)
  }
  return map
}

/**
 * Families put on a side by name, not by the hash: the hash left every phone-* family in train, so no held-out request
 * called the phone.
 */
const PINNED = {'phone-call': 'test', 'phone-calendar': 'test', 'phone-vibrate': 'validation'}

/** train / validation / test from the family alone, so no family is on two sides. */
function splitOf(family) {
  if (PINNED[family]) return PINNED[family]
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

/**
 * Whether the whole screen a run wrote served as its writer wrote it (result.json): built, and not mended by edits once it
 * was assembled (AgentRepair.ets's settleProgram notes "; repaired by edits in N round(s)" just before it says so).
 */
function wholeServed(run, label) {
  const file = path.join(run, label, 'result.json')
  if (!fs.existsSync(file)) return false
  const result = JSON.parse(fs.readFileSync(file, 'utf8'))
  const note = result.note || ''
  return result.route === 'agent' && /; whole screen written in /.test(note) && !/; repaired by edits in \d+ round\(s\); whole screen written in /.test(note)
}

/**
 * The widget part of a widget writer's system prompt: languageWith (AgentSurface.ets) puts the card catalogue and the guide
 * where the language's UI catalogue was, between the same two marks; null when the prompt is not built so.
 */
function widgetSystem(system, language) {
  if (language === null) return null
  const start = language.indexOf('UI constructors (all return ui.View):')
  const end = language.indexOf('Clock -- time.')
  if (start < 0 || end <= start) return null
  const head = language.slice(0, start)
  const tail = language.slice(end)
  if (!system.startsWith(head) || !system.endsWith(tail) || system.length <= head.length + tail.length) return null
  return system.slice(head.length, system.length - tail.length).trim()
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

/** A rule only the section contract of b01-b02 has: the phone sends today's (with the phone functions found), not it. */
const OLD_SECTION_RULE = 'The section never calls sdk.call, except'

/**
 * A refusal that puts the limit on phones in general ("phones do not let an app...", "the phone doesn't give apps a live
 * camera picture"): false on a phone whose camera the same data calls, and a 0.5B model learns to make such limits up.
 * The limit is this app's.
 */
const PHONE_LIMIT = /\b(phones? (do(es)?n.t|do(es)? not|only|can.t|cannot|never)|a phone (only|does not|doesn.t|can.t|cannot)|no phone)\b/i

const EDIT_BLOCK = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g

/** The text a reply's SEARCH parts are copied from, as its request quotes it; null when the request quotes none. */
function editedText(user, task) {
  if (task === 'program-edit' || task === 'program-repair' || task === 'program-rewrite') {
    const made = user.match(/^The program:\n([\s\S]*?)\n\nIt was made for:/)
    if (made) return made[1]
    const at = user.indexOf('\n\nRequest: ')
    return at > 0 ? user.slice(0, at) : null
  }
  if (user.includes(FAILED_MARK)) {
    const failed = user.match(/(?:Your section was:\n|Your section:\n)([\s\S]*?)\n\nIt failed:/)
    return failed ? failed[1] : null
  }
  const now = user.match(/The section as it is now[^\n]*\n([\s\S]*?)\n\nThe program so far/)
  return now ? now[1] : null
}

/**
 * What is wrong with a reply's edits, '' when nothing: markers the app's parser may forgive but a model must not learn
 * (`<<<<<<<SEARCH`), a fence, or a SEARCH part not found exactly once in what it edits.
 */
function editFault(user, reply, task) {
  if (reply.includes('```')) return 'in a code fence'
  const markers = reply.split('\n').filter(l => /^(<{7}|={7}|>{7})/.test(l))
  if (markers.length === 0) return ''
  if (markers.some(l => !/^(<<<<<<< SEARCH|=======|>>>>>>> REPLACE)$/.test(l))) return 'edit markers misspelt'
  const blocks = [...reply.matchAll(EDIT_BLOCK)]
  if (blocks.length * 3 !== markers.length) return 'edit markers unpaired'
  const text = editedText(user, task)
  if (text === null) return ''
  for (const [, search] of blocks) {
    const n = text.split(search).length - 1
    if (n !== 1) return n === 0 ? 'a SEARCH part not in what it edits' : 'a SEARCH part found more than once'
  }
  return ''
}

/**
 * A catalogue hole whose kept bodies do not do what its request asks, though they passed the behaviour check, which reads
 * only the filter's general behaviour: hiding the rows that match (they show them), an exact title (they match a part),
 * spaces trimmed (no trim is among the functions allowed, so the bodies ignore it).
 */
function holeContradicts(user, bodies) {
  const request = user.slice(user.lastIndexOf('Request: ') + 'Request: '.length)
  const all = Object.values(bodies).join('\n')
  if (/\bhide rows matching\b/i.test(request)) return 'shows the rows it was asked to hide'
  if (/\bexact title\b/i.test(request) && !/\blabel === query\b|\bquery === label\b/.test(all)) return 'matches part of a title asked to match exactly'
  if (/\bspaces trimmed\b/i.test(request)) return 'cannot trim with the functions allowed'
  return ''
}

/** The same bodies kept for at most this many requests of a turn: one filter answered 69 of them alike, and b04 has a few answers in all. */
const SAME_BODIES_AT_MOST = 10

/** The most of train that program edits (program-edit refine) may be. */
const PROGRAM_EDIT_SHARE = 0.4

const sameBodies = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort())

function main() {
  const familyOf = families()
  const verdictOf = verdicts()
  // tools/refusal-check.js: rules for a program's refusal, a strict judge for a section's; a person's verdict wins.
  const autoOf = verdicts('auto-verdicts.tsv')
  const rows = {train: [], validation: [], test: []}
  const review = []
  const seen = new Set()
  // turn + catalogue answer -> how many requests it was kept for (SAME_BODIES_AT_MOST).
  const sameAnswers = new Map()
  const stats = {requests: 0, holes: 0, kept: {}, dropped: {}, bySplit: {}, byFamily: {}}
  const drop = why => { stats.dropped[why] = (stats.dropped[why] || 0) + 1 }
  const count = (table, key) => { table[key] = (table[key] || 0) + 1 }
  /**
   * The phone's chat (chat-run.js, VeraChat.ets's chatReply), one example for each model request it made: the messages as the
   * app sent them, the tools it offered, and the answer -- text, or tool calls the app then ran. A tool call is kept when it
   * names an offered tool with arguments that read as JSON; an answer, when the turn's whole reply passed parseReply (a
   * widget marker cut or malformed fails it) and it does not echo the history's "[messageId=N]" prefix.
   */
  const chatSteps = (events, family, label, run) => {
    let next = 0
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (e.kind !== 'ask' || e.task !== 'chat') continue
      stats.holes++
      const turn = events.slice(i + 1).find(t => t.kind === 'turn')
      const request = e.request || {}
      const reply = e.reply || {}
      if (e.status !== 200 || !Array.isArray(request.messages)) { drop('chat: request failed'); continue }
      const offered = new Set((request.tools || []).map(t => t.function && t.function.name))
      let answer
      if (reply.finish === 'tool_calls') {
        const fine = reply.tool_calls.length > 0 && reply.tool_calls.every(c => {
          try { JSON.parse(c.function.arguments); return offered.has(c.function.name) } catch (x) { return false }
        })
        if (!fine) { drop('chat: a tool call not offered or not JSON'); continue }
        answer = {role: 'assistant', content: reply.content || '', tool_calls: reply.tool_calls}
      } else if (reply.finish === 'stop') {
        if (!turn || turn.error) { drop('chat: the reply did not parse'); continue }
        if (/\[messageId=\d+\]/.test(reply.content)) { drop('chat: echoes a messageId'); continue }
        if (!reply.content.trim()) { drop('chat: empty answer'); continue }
        answer = {role: 'assistant', content: reply.content}
      } else { drop('chat: not finished (' + (reply.finish || 'none') + ')'); continue }
      const messages = request.messages.concat([answer])
      const key = crypto.createHash('sha256').update(JSON.stringify(request.messages)).digest('hex')
      if (seen.has(key)) { drop('duplicate request'); continue }
      seen.add(key)
      const split = splitOf(family)
      const metadata = {task: 'chat', turn: reply.finish === 'tool_calls' ? 'tool-call' : 'answer', label, run: path.basename(run),
        step: next++, person: turn ? turn.turn : null, widget: Boolean(turn && turn.widget && reply.finish === 'stop'),
        teacher: reply.model || TEACHER, usage: reply.usage || null,
        checks: reply.finish === 'tool_calls' ? ['tool offered', 'arguments JSON'] : ['parseReply']}
      rows[split].push({messages, tools: request.tools || [], metadata: Object.assign({family, split}, metadata)})
      count(stats.kept, 'chat ' + metadata.turn)
      count(stats.bySplit, split)
      count(stats.byFamily, family)
    }
  }
  /**
   * What a running program asks (runtime-run.js), each kept by what the app makes of it:
   *   source-find -- the finder's two asks (candidate addresses from the search, where each figure is in a sample answer),
   *                  when the host fetched the address and read every figure at the paths named;
   *   live-read   -- Vera.Live.fetch's reading of the search, when every figure asked came back found in a result;
   *   ask-text    -- Vera.Ask.text's words, when they are words (no error) within the word limit and not cut off.
   */
  const runtimeSteps = (events, family, label, run) => {
    const asks = events.filter(e => e.kind === 'ask')
    const plain = (e, task, turn, extra) => {
      const m = (e.request || {}).messages || []
      if (e.status !== 200 || m.length !== 2 || e.reply.finish !== 'stop') return drop(task + ': not answered')
      keep(family, m[0].content, m[1].content, e.reply.content, Object.assign({task, turn, label, run: path.basename(run),
        teacher: e.reply.model || TEACHER, usage: e.reply.usage || null}, extra))
    }
    const source = events.find(e => e.kind === 'source')
    if (source) {
      stats.holes++
      if (!source.ok) drop('source-find: no source the host could read')
      else {
        const find = asks.filter(e => e.task === 'source-find' && e.request.messages[0].content.startsWith('You find a free public HTTP JSON API'))
        const pick = asks.filter(e => e.task === 'source-find' && e.request.messages[0].content.startsWith('Given a request for live figures'))
        if (find.length) plain(find[find.length - 1], 'source-find', 'candidates', {checks: ['address fetched', 'figures read at the paths']})
        if (pick.length) plain(pick[pick.length - 1], 'source-find', 'paths', {checks: ['figures read at the paths']})
      }
    }
    const live = events.find(e => e.kind === 'live')
    if (live) {
      stats.holes++
      const lines = String(live.answer || '').split('\n')
      const read = asks.filter(e => e.task === 'live-read')
      if (lines[0] !== 'ok' || live.labels.some((_, i) => !(lines[i + 1] || '').trim())) drop('live-read: ' + (lines[0] === 'ok' ? 'a figure not found' : lines[0].slice(0, 40)))
      else if (read.length) plain(read[read.length - 1], 'live-read', 'read', {checks: ['figure found in a result']})
    }
    const asked = events.find(e => e.kind === 'ask-result')
    if (asked) {
      stats.holes++
      const text = String(asked.answer || '')
      const writes = asks.filter(e => e.task === 'ask-text')
      if (text.startsWith('error')) drop('ask-text: ' + text.slice(0, 40))
      else if (text.split(/\s+/).filter(Boolean).length > Number(asked.maxWords)) drop('ask-text: over the word limit')
      else if (writes.length) plain(writes[writes.length - 1], 'ask-text', 'write', {maxWords: Number(asked.maxWords), checks: ['words', 'within the limit']})
    }
  }
  /** One example, unless the same request was already kept. */
  const keep = (family, system, user, reply, metadata) => {
    // Scenes are not in v1: neither a scene written nor anything written into a program that has one (its prompt
    // carries the scene guide).
    if (SCENE.test(reply) || SCENE.test(user)) { drop(metadata.task + ': scene in the program'); return }
    if (system.includes(OLD_SECTION_RULE)) { drop(metadata.task + ': section contract of b01-b02'); return }
    const fault = editFault(user, reply, metadata.task)
    if (fault) { drop(metadata.task + ': ' + fault); return }
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
    const contradiction = holeContradicts(first.user, fill.bodies)
    if (contradiction) return drop('catalogue hole: ' + contradiction)
    const kept = Object.fromEntries(Object.entries(fill.bodies).map(([k, v]) => [k, asWritten(v)]))
    // The answer as the first try is written, for the repair too: the teacher's repair indented each line by two spaces
    // (cleanBody's indent), the first try not, and a small model sees two forms of one answer.
    const answer = '{"holes": {' + Object.entries(kept).map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v)).join(', ') + '}}'
    const meta = turn => ({task: 'catalogue-hole', turn, label, run: path.basename(run), hole: fill.hole || null,
      calls: asks.length, teacher: first.model || TEACHER, checks: fill.behaviour !== undefined ? ['compiled', 'behaviour', 'targets found'] : ['compiled']})
    const often = turn => { const k = turn + '\u0000' + answer; sameAnswers.set(k, (sameAnswers.get(k) || 0) + 1); return sameAnswers.get(k) > SAME_BODIES_AT_MOST }
    if (often('first')) drop('catalogue hole: the same bodies kept for more requests')
    else keep(family, first.system, first.user, answer, Object.assign(meta('first'),
      {source: sameBodies(first.parsed, fill.bodies) ? 'first try' : 'kept after repair'}))
    const repair = asks.slice(1).reverse().find(a => !a.error && a.finish === 'stop' && sameBodies(a.parsed, fill.bodies))
    if (repair) {
      const error = (repair.user.match(/"message": ("(?:[^"\\]|\\.)*")/) || [])[1]
      if (often('repair')) drop('catalogue hole: the same bodies kept for more requests')
      else keep(family, repair.system, repair.user, answer, Object.assign(meta('repair'), {error: error ? JSON.parse(error) : null}))
    }
  }
  /**
   * The text of the catalogue's sections (VeraTemplateContent.ets's fillSectionsContent), one ask, settled by the fill after
   * it: kept when its JSON was read ("content: ...") and no list in it came back in a shape the app could not use. A field
   * left at its default is not a failure: the eyebrow is left so on every one of b05-b07's 132.
   */
  const catalogueContent = (fill, asks, family, label, run) => {
    stats.holes++
    const last = asks[asks.length - 1]
    const note = fill.content || ''
    if (!note.startsWith('content: ')) return drop('catalogue content: ' + (note || 'no note'))
    if (/=default\(bad/.test(note)) return drop('catalogue content: a list in a bad shape')
    if (last.error || last.finish !== 'stop') return drop('catalogue content: not finished')
    keep(family, last.system, last.user, last.reply, {task: 'catalogue-content', turn: 'first', label, run: path.basename(run),
      fields: note.slice('content: '.length), searched: /\bsearch=ok\b/.test(note), calls: asks.length,
      teacher: last.model || TEACHER, usage: last.usage || null, checks: ['json read', 'lists in shape']})
  }
  /**
   * The whole program written again when neither way of a refine made the change (agent-run's rewriteProgram, as
   * GeneratePage's refineWithModel), asked with no tools and the phone functions for the change in the request. Kept when it
   * passed (compiled, every handler run) and Jev reads it as making the change, with no phone target the program and the
   * functions found do not name. Served from the first reply: the program as the app read it; after a repair round, the
   * repair that mended it. The system prompt is cut to one line, as a program edit's is.
   */
  const rewrite = (events, family, label, run, language) => {
    const made = events.find(e => e.kind === 'rewrite')
    if (!made) return
    stats.holes++
    if (!made.base) return drop('program-rewrite: asked of no program')
    if (!made.ok) return drop('program-rewrite: failed')
    // Jev misses removals and a new look, as it does a program edit's: the second judge (tools/rejudge.js) settles those.
    const judged = judgeOf(events, 'rewrite')
    if (!made.does && !(judged && judged.done)) return drop('program-rewrite: Jev does not read the change' + (judged ? ', nor the judge' : ''))
    const asks = events.filter(e => e.kind === 'ask' && e.task === 'program-rewrite')
    const last = asks[asks.length - 1]
    if (!last || last.error || last.finish !== 'stop') return drop('program-rewrite: not finished')
    if (language === null || !last.system.startsWith(language)) return drop('program-rewrite: system prompt without the language')
    const allowed = new Set(targetsIn(made.base || '').concat(targetsIn(last.user)))
    if (targetsIn(made.source).some(t => !allowed.has(t) && t !== ASK_TARGET)) return drop('program-rewrite: calls a target nobody named')
    const repaired = last.user.includes('is your previous attempt and it failed validation')
    keep(family, REWRITE_SYSTEM, last.user, repaired ? last.reply : made.written, {task: 'program-rewrite', turn: repaired ? 'refine-repair' : 'refine',
      label, run: path.basename(run), change: made.change, depth: made.depth || 0, calls: asks.length, attempts: made.attempts, rounds: made.rounds,
      teacher: last.model || TEACHER, usage: last.usage || null, checks: ['compiled', 'smoke run', made.does ? 'Jev reads the change' : 'the judge reads the change', 'targets named']})
  }
  /**
   * Make widget (agent/AgentWidget.ets's writeWidget; agent-run --home-widget or --widgets-for): kept when the widget
   * spliced into the program passed its checks (compiled, every handler tapped, the card's checks). The answer is what the
   * app read out of the last reply (sourceIn, without a fence), and the system prompt is the language's widget part alone:
   * the card catalogue and the widget guide that languageWith (AgentSurface.ets) puts in place of the UI catalogue.
   */
  const widget = (events, family, label, run, language) => {
    const made = events.find(e => e.kind === 'widget')
    if (!made) return
    stats.holes++
    if (!made.ok) return drop('widget: ' + String(made.failed || 'failed').split(':')[0].slice(0, 60))
    const asks = events.filter(e => e.kind === 'ask')
    const last = asks[asks.length - 1]
    if (!last || last.error) return drop('widget: no answer recorded')
    const system = widgetSystem(last.system, language)
    if (system === null) return drop('widget: system prompt not the language with the widget part')
    keep(family, system, last.user, made.written, {task: 'widget', turn: last.user.includes('\n\nYour previous answer:\n') ? 'repair' : 'first',
      label, run: path.basename(run), shows: made.shows, calls: asks.length, teacher: last.model || TEACHER, usage: last.usage || null,
      checks: ['compiled', 'every handler run', 'card checks']})
  }
  /**
   * The assembled program repaired by edits (AgentRepair.ets's repairProgram, asked with the language alone, like a program
   * edit's repair): the last of the asks after the last hole, when result.json says the repair mended it.
   */
  const programRepair = (asks, run, family, label, language) => {
    const repairs = asks.filter(a => a.user.includes('is your previous attempt and it failed validation'))
    if (repairs.length === 0) return
    stats.holes++
    const file = path.join(run, label, 'result.json')
    const note = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).note || '' : ''
    if (!/; repaired by edits in \d+ round\(s\)/.test(note)) return drop('program repair: not mended')
    const last = repairs[repairs.length - 1]
    if (last.error || last.finish !== 'stop') return drop('program repair: not finished')
    if (language === null || !last.system.startsWith(language)) return drop('program repair: system prompt without the language')
    keep(family, last.system.slice(language.length).trimStart() || EDIT_SYSTEM, last.user, last.reply, {task: 'program-repair', turn: 'repair',
      label, run: path.basename(run), rounds: repairs.length, teacher: last.model || TEACHER, usage: last.usage || null,
      checks: ['compiled', 'smoke run']})
  }
  /**
   * Refines of a built screen (agent-run.js --refine): each change made by edits of the whole program and by the written
   * section changed. A way is kept when it passed its checks and Jev reads it as making the change. Edits that served
   * with no repair round are kept as the change's answer; after a repair, the repair that mended them is kept instead.
   */
  const refines = (events, family, label, run, language) => {
    rewrite(events, family, label, run, language)
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
          const key = label + ' ' + route + ' ' + edit.change
          // A person's word wins; the rules and the judge did not look for a limit put on phones in general.
          const auto = autoOf.get(key) === 'accept' && PHONE_LIMIT.test(last0.reply) ? 'reject' : autoOf.get(key)
          const verdict = verdictOf.get(key) || auto || 'unread'
          if (verdict === 'accept') {
            keep(family, system, last0.user, last0.reply, {task, turn: 'refine-decline', label, run: path.basename(run), change: edit.change,
              calls: asks.length, teacher: last0.model || TEACHER, usage: last0.usage || null,
              checks: [verdictOf.has(key) ? 'refusal read' : (route === 'program' ? 'refusal rules' : 'refusal judge')]})
          } else {
            review.push({kind: 'impossible change', verdict, key, label, family, route, change: edit.change,
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
      const widgetFile = path.join(run, label, 'widget', 'asks.jsonl')
      const refineDir = path.join(run, label, 'refine')
      // A run of widgets or rewrites alone (agent-run --widgets-for, --rewrites-for) has no asks of its own beside them.
      if (!fs.existsSync(file) && !fs.existsSync(widgetFile) && !fs.existsSync(refineDir)) continue
      stats.requests++
      const family = familyOf.get(label)
      if (!family) { drop('label in no batch file'); continue }
      if (fs.existsSync(widgetFile)) widget(fs.readFileSync(widgetFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), family, label, run, language)
      if (fs.existsSync(refineDir)) {
        // "0", "1", ... a change on the screen as built; "0.1", "0.1.2" the changes after it in a chain (agent-run --chain).
        for (const k of fs.readdirSync(refineDir).filter(d => /^\d+(\.\d+)*$/.test(d)).sort()) {
          const refineFile = path.join(refineDir, k, 'asks.jsonl')
          if (fs.existsSync(refineFile)) refines(fs.readFileSync(refineFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)), family, label, run, language)
        }
      }
      if (!fs.existsSync(file)) continue
      const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      if (events.some(e => e.kind === 'ask' && e.task === 'chat')) { chatSteps(events, family, label, run); continue }
      if (events.some(e => e.kind === 'ask' && RUNTIME_TASKS.has(e.task))) { runtimeSteps(events, family, label, run); continue }
      let group = []
      let holeAsks = []
      let contentAsks = []
      let missed = 0
      for (const e of events) {
        if (e.kind === 'ask' && e.task === 'section') { group.push(e); continue }
        if (e.kind === 'ask' && e.task === 'catalogue-hole') { holeAsks.push(e); continue }
        if (e.kind === 'ask' && e.task === 'content') { contentAsks.push(e); continue }
        // A phone lookup the replayed cache did not hold: the writer was shown nothing where the phone would show functions.
        if (e.kind === 'lookup' && !e.hit) { missed++; continue }
        if (e.kind === 'fill') {
          const asked = contentAsks
          contentAsks = []
          if (asked.length > 0) catalogueContent(e, asked, family, label, run)
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
        // The whole screen as one hole (VeraBuildRoute.ets; agent-run -r or --whole) is a section of its own task: the
        // same form, asked of an empty program. It is kept only when the screen served as it was written.
        const task = e.whole ? 'whole-screen' : 'section'
        const why = text => e.whole ? 'whole screen: ' + text : text
        if (e.whole && !wholeServed(run, label)) { drop(why('not served as written')); continue }
        // A hole reported because every try failed is not a refusal: its `why` is the failure, which starts 'custom section'.
        if (e.outcome === 'reported' && e.why && e.why.startsWith('custom section')) { drop(why('reported: failed')); continue }
        if (e.outcome === 'reported' && e.why) {
          review.push({label, family, prompt: e.prompt, needs: e.needs, why: e.why, reply: last.reply})
          drop(why('reported: to review'))
          continue
        }
        const unmet = e.missed || []
        const declined = declinedIn(last.reply)
        // Served with the needs it could not do declined in its own words (<cannot need>): a partial refusal, read by
        // a person before it is trained on (Jev reads what a section does, not whether a refusal is right).
        if (e.outcome === 'partial' && unmet.length > 0 && unmet.every(m => declined.some(d => sameNeed(d, m))) &&
            language !== null && last.system.startsWith(language) && last.finish === 'stop' && !SCENE.test(last.reply)) {
          const system = last.system.slice(language.length).trimStart()
          // A whole screen and a section of the same request are read apart: "<label> whole" in review/verdicts.tsv.
          const key = e.whole ? label + ' whole' : label
          const verdict = verdictOf.get(key) || 'unread'
          if (verdict === 'accept') {
            keep(family, system, last.user, last.reply, {task, turn: 'decline', label, run: path.basename(run), needs: e.needs,
              declined: unmet, calls: asks.length, phoneCalls: (last.reply.match(/sdk\.call\(/g) || []).length,
              teacher: last.model || TEACHER, usage: last.usage || null, checks: ['compiled', 'smoke run', 'targets found', 'Jev', 'refusal read']})
            continue
          }
          review.push({kind: 'partial decline', verdict, key, label, family, prompt: e.prompt, needs: e.needs, missed: unmet,
            messages: [{role: 'system', content: system}, {role: 'user', content: last.user}, {role: 'assistant', content: last.reply}]})
          drop(why('partial decline: ' + verdict))
          continue
        }
        if (e.outcome !== 'written') { drop(why(e.outcome)); continue }
        if (unmet.length > 0) { drop(why('missed needs')); continue }
        if (last.error || last.finish !== 'stop') { drop(why('not finished')); continue }
        if (SCENE.test(last.reply)) { drop(why('scene')); continue }
        if (language === null || !last.system.startsWith(language)) { drop(why('system prompt without the language')); continue }
        if (!matchesRecord(last.reply, e.code || '')) { drop(why('reply is not the section kept')); continue }
        const system = last.system.slice(language.length).trimStart()
        const turn = last.user.includes(FAILED_MARK) ? 'repair' : 'first'
        keep(family, system, last.user, last.reply, {task, turn, label, run: path.basename(run), needs: e.needs,
          calls: asks.length, declines: (last.reply.match(/<cannot\s+need=/g) || []).length,
          phoneCalls: (last.reply.match(/sdk\.call\(/g) || []).length, teacher: last.model || TEACHER,
          usage: last.usage || null, checks: ['compiled', 'smoke run', 'targets found', 'Jev']})
      }
      // What is left after the last hole is the assembled program's repair (AgentRepair.ets's settleProgram), when it took one.
      programRepair(group, run, family, label, language)
    }
  }
  // Program edits are half of what the runs give (every change is asked both ways, and most are made by edits): in train
  // they are kept to at most PROGRAM_EDIT_SHARE of it, the changes later in a chain let go first, then by a fixed hash.
  // Validation and test keep every one.
  const isEdit = r => r.metadata.task === 'program-edit' && r.metadata.turn === 'refine'
  const edits = rows.train.filter(isEdit)
  const others = rows.train.length - edits.length
  const room = Math.floor(PROGRAM_EDIT_SHARE / (1 - PROGRAM_EDIT_SHARE) * others)
  if (edits.length > room) {
    const order = r => (r.metadata.depth ? '1' : '0') + crypto.createHash('sha256').update(r.messages[1].content).digest('hex')
    const letGo = new Set(edits.slice().sort((a, b) => order(a) < order(b) ? -1 : 1).slice(room))
    rows.train = rows.train.filter(r => !letGo.has(r))
    stats.kept['program-edit refine'] -= letGo.size
    stats.bySplit.train -= letGo.size
    for (const r of letGo) stats.byFamily[r.metadata.family]--
    stats.dropped['program-edit: over its share of train'] = letGo.size
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
