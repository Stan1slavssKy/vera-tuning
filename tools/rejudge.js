#!/usr/bin/env node
// A second judge for program edits Jev did not read as making the change: DeepSeek, thinking, shown the change, the
// program before and the program after (a multiset of changed lines lost their order and read as broken code: the
// judge called programs that compiled "invalid"), answers whether the change is fully made. Its word is
// appended to the refine's asks.jsonl as a `judge` event, which tools/export.js reads. $ARKESTR_API_KEY.
//
//   node tools/rejudge.js capture/<run> [...]
//
// Only edits that compiled and ran are judged, and each once (a refine with a judge event is skipped). The judge is the
// teacher, so it is told to be strict: a change half made, or made somewhere it does not show, is not made.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const SYSTEM = 'You check whether a change asked for an app was made. You are shown the change, the program before it ' +
  '(VERA, a TypeScript-like language whose view() builds the screen) and the program after it, which compiles and runs. ' +
  'Answer done only when a person using the app would see the whole change working as asked: not half of it, not in a ' +
  'place it never shows, not something else instead. Reply with JSON only: {"done": true|false, "why": "one sentence"}'

async function judge(change, before, after) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ARKESTR_API_KEY},
    body: JSON.stringify({model: 'deepseek-flash', temperature: 0, max_tokens: 6000, thinking: {type: 'enabled'}, reasoning_effort: 'low',
      response_format: {type: 'json_object'}, messages: [{role: 'system', content: SYSTEM},
        {role: 'user', content: 'The change: ' + change + '\n\nThe program before:\n' + before + '\n\nThe program after:\n' + after}]})})
  const body = await res.json()
  if (!res.ok) throw Error('DeepSeek HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
  const answer = JSON.parse(body.choices[0].message.content)
  return {done: answer.done === true, why: String(answer.why || ''), model: body.model}
}

;(async () => {
  const jobs = []
  for (const run of process.argv.slice(2)) {
    for (const label of fs.readdirSync(run)) {
      const refine = path.join(run, label, 'refine')
      const base = path.join(run, label, 'program.vera')
      if (!fs.existsSync(refine) || !fs.existsSync(base)) continue
      for (const k of fs.readdirSync(refine).filter(d => /^\d+$/.test(d))) {
        const file = path.join(refine, k, 'asks.jsonl')
        if (!fs.existsSync(file)) continue
        const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        if (events.some(e => e.kind === 'judge' && e.route === 'program')) continue
        const edit = events.find(e => e.kind === 'edit' && e.route === 'program')
        if (!edit || !edit.ok || edit.does) continue
        jobs.push({file, label, change: edit.change, before: fs.readFileSync(base, 'utf8'), after: edit.source})
      }
    }
  }
  let done = 0, yes = 0
  const queue = jobs.slice()
  await Promise.all(Array.from({length: 8}, async () => {
    while (queue.length) {
      const j = queue.shift()
      try {
        const v = await judge(j.change, j.before, j.after)
        fs.appendFileSync(j.file, JSON.stringify({label: j.label, change: j.change, kind: 'judge', route: 'program', ...v}) + '\n')
        done++; if (v.done) yes++
      } catch (e) { console.error(j.label, e.message) }
    }
  }))
  console.log(`judged ${done} of ${jobs.length}: done ${yes}, not done ${done - yes}`)
})()
