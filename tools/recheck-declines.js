#!/usr/bin/env node
// The section a refusal of an impossible change keeps beside its <cannot need> tags, checked as the app checks a written
// section (AgentCustom.ets's check, through stillWorks): put in place of the screen's written section (composition.json,
// the screen as built: an impossible change is never later in a chain), composed (composeFrom), compiled, run once with
// every handler tapped, every field it sets read. The app never serves such a section when the one need is declined, so a
// refusal's code was not checked by the run itself.
//
//   VERA_HARNESS=../vera-probe-distill/tools/vera-harness node tools/recheck-declines.js data/v1
//
// Writes review/section-decline-checks.tsv (key<TAB>ok|fail<TAB>why), which tools/export.js reads: a section refusal is
// kept only when its section passed.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const harness = path.resolve(process.env.VERA_HARNESS || path.join(root, '..', 'vera-probe-distill', 'tools', 'vera-harness'))
const {loadVera} = require(path.join(harness, 'source-loader'))
const {compositionFromJson, composeFrom} = loadVera('VeraComposition')
const {parseSection, stillWorks} = loadVera('agent/AgentCustom')
const {writtenSectionAt} = loadVera('agent/AgentSectionEdit')
const {applyRepair} = loadVera('VeraRepair')
const {compileVeraSource} = loadVera('VeraCompiler')

const data = process.argv[2] || path.join(root, 'data', 'v1')
const rows = ['train', 'validation', 'test'].flatMap(s => fs.existsSync(path.join(data, s + '.jsonl')) ?
  fs.readFileSync(path.join(data, s + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
  .filter(r => r.metadata.task === 'section-edit' && r.metadata.turn === 'refine-decline')
// Refusals read before (review.jsonl of an export) are checked too, so the file holds every one export may meet.
const reviewFile = path.join(data, 'review.jsonl')
const reviewed = fs.existsSync(reviewFile) ? fs.readFileSync(reviewFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(r => r.kind === 'impossible change' && r.route === 'section')
  .map(r => ({messages: r.messages, metadata: {label: r.label, change: r.change, run: null}})) : []

/** The run a label was captured in: the one whose folder has its composition. */
function runOf(label, run) {
  if (run) return path.join(root, 'capture', run)
  for (const d of fs.readdirSync(path.join(root, 'capture'))) {
    if (fs.existsSync(path.join(root, 'capture', d, label, 'composition.json'))) return path.join(root, 'capture', d)
  }
  return null
}

function check(row) {
  const {label, change} = row.metadata
  const user = row.messages[1].content
  const reply = row.messages[2].content
  const run = runOf(label, row.metadata.run)
  const file = run && path.join(run, label, 'composition.json')
  if (!file || !fs.existsSync(file)) return ['fail', 'no composition of the screen']
  const c = compositionFromJson(fs.readFileSync(file, 'utf8'))
  const at = c ? writtenSectionAt(c) : -1
  if (at < 0) return ['fail', 'the screen has no written section']
  // Edits mend the section the request quotes as failed (the writer's own rounds); else the reply is the section.
  let text = reply
  if (reply.includes('<<<<<<< SEARCH')) {
    const failed = user.match(/(?:Your section was:\n|Your section:\n)([\s\S]*?)\n\nIt failed:/)
    if (!failed) return ['fail', 'edits with no section quoted to apply them to']
    const applied = applyRepair(failed[1], reply)
    if (!applied.source) return ['fail', 'the edits do not apply: ' + String(applied.error).slice(0, 80)]
    text = applied.source
  }
  const section = parseSection(text)
  if (!section) return ['fail', 'not a section']
  section.criteria = c.blocks[at].literal.criteria
  const copy = c.copy()
  copy.blocks[at].literal = section
  const source = composeFrom(copy)
  if (stillWorks(source)) return ['ok', 'compiles, runs, every field read']
  let why = 'runs wrong or leaves a field unread'
  try { compileVeraSource(source) } catch (e) { why = 'does not compile: ' + String(e.message).split('\n')[0].slice(0, 100) }
  return ['fail', why]
}

const lines = []
const tally = {}
for (const row of rows.concat(reviewed)) {
  const key = row.metadata.label + ' section ' + row.metadata.change
  let verdict
  try { verdict = check(row) } catch (e) { verdict = ['fail', 'check threw: ' + String(e.message).split('\n')[0].slice(0, 100)] }
  lines.push([key, ...verdict].join('\t').replace(/\n/g, ' '))
  tally[verdict[0]] = (tally[verdict[0]] || 0) + 1
}
const out = path.join(root, 'review', 'section-decline-checks.tsv')
fs.writeFileSync(out, '# key\tok|fail\twhy -- tools/recheck-declines.js; tools/export.js keeps a section refusal only when ok\n' +
  [...new Map(lines.map(l => [l.split('\t')[0], l])).values()].join('\n') + '\n')
console.log(JSON.stringify(tally), 'written to', path.relative(root, out))
