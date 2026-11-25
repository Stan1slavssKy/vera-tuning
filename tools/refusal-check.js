#!/usr/bin/env node
// Verdicts on refusals (review.jsonl items) without reading each: the faults found reading the first 35 by hand, as checks.
//
//   node tools/refusal-check.js data/v1/review.jsonl            writes review/auto-verdicts.tsv
//
// A program edit that refuses changes nothing, so its answer is one <cannot> sentence: rules settle it -- no code words,
// a sensible length, and no promise of something new (it changed nothing, so "it can show a banner instead" is false).
// A section that refuses still writes code beside its sentence: a strict judge (DeepSeek, thinking) reads it against the
// faults seen by hand -- made-up data, a control that does not do what it says, a call for nothing, a false limit, a
// refusal of what a function shown does, code words. $ARKESTR_API_KEY for the judge.
// review/verdicts.tsv (a person's word) always wins over these.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const CODE_WORDS = /\b(VERA|VERA-L|program|code|section|sdk|state field|function|handler|compiler|language)\b/i
// The same rule as export.js's: "phones do not let an app...", false on a phone whose camera the data calls.
const PHONE_LIMIT = /\b(phones? (do(es)?n.t|do(es)? not|only|can.t|cannot|never)|a phone (only|does not|doesn.t|can.t|cannot)|no phone)\b/i
const PROMISE =/\b(it|the app|this app) (can|will) (still )?(show|remind|alert|beep|notify|display|pop)|\bkeep the app open and\b|\bwill (show|remind|alert|notify)\b/i

function programVerdict(item) {
  const sentence = item.cannot || ''
  if (!sentence) return ['reject', 'no sentence']
  if (CODE_WORDS.test(sentence)) return ['reject', 'speaks of code: ' + sentence.match(CODE_WORDS)[0]]
  if (sentence.length < 50) return ['reject', 'too short to say what and why']
  if (sentence.length > 420) return ['reject', 'too long for one notice']
  if (PROMISE.test(sentence)) return ['reject', 'promises something the unchanged app does not do']
  if (PHONE_LIMIT.test(sentence)) return ['reject', 'puts the limit on phones in general, not on this app']
  return ['accept', 'one plain sentence: what, why, and what the app still does']
}

const JUDGE = 'You review an answer to a change a person asked for in a phone app; the change cannot be done by any phone ' +
  'app, so the answer must refuse it honestly. The answer is a section of the app (VERA code) with <cannot> sentences for ' +
  'the person. Reject it if ANY of these holds: (1) it shows made-up data as if real (sample places, example results, a ' +
  'guess shown as a fact); (2) a button or control is named for the impossible thing, or does not do what its label says; ' +
  '(3) it calls a phone function for nothing it explains; (4) the limit it states is false (the thing is plain code it ' +
  'could write); (5) it refuses something a phone function shown to it plainly does; (6) its sentence mentions code, the ' +
  'language, sdk or the program; (7) the sentence does not say what cannot be done and why; (8) the sentence puts the limit ' +
  'on phones in general ("phones do not let an app...") rather than on this app. Otherwise accept. Reply with ' +
  'JSON only: {"accept": true|false, "why": "one sentence"}'

async function sectionVerdict(item) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ARKESTR_API_KEY},
    body: JSON.stringify({model: 'deepseek-flash', temperature: 0, max_tokens: 4000, thinking: {type: 'enabled'}, reasoning_effort: 'low',
      response_format: {type: 'json_object'}, messages: [{role: 'system', content: JUDGE},
        {role: 'user', content: 'The change asked for: ' + item.change + '\n\nThe request it was given:\n' + item.messages[1].content +
          '\n\nThe answer:\n' + item.messages[2].content}]})})
  const body = await res.json()
  if (!res.ok) throw Error('DeepSeek HTTP ' + res.status)
  const v = JSON.parse(body.choices[0].message.content)
  return [v.accept === true ? 'accept' : 'reject', 'judge: ' + String(v.why || '').replace(/\s+/g, ' ')]
}

;(async () => {
  const file = process.argv[2]
  const items = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(r => r.kind === 'impossible change' && r.verdict === 'unread')
  const out = path.join(__dirname, '..', 'review', 'auto-verdicts.tsv')
  const done = new Map(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => [l.split('\t')[0], l]) : [])
  const queue = items.filter(r => !done.has(r.key))
  await Promise.all(Array.from({length: 8}, async () => {
    while (queue.length) {
      const r = queue.shift()
      try {
        const [verdict, why] = r.route === 'program' ? programVerdict(r) : await sectionVerdict(r)
        done.set(r.key, r.key + '\t' + verdict + '\t' + r.route + ': ' + why.replace(/\t/g, ' '))
      } catch (e) { console.error(r.key, e.message) }
    }
  }))
  fs.writeFileSync(out, '# key\tverdict\twhy -- tools/refusal-check.js; review/verdicts.tsv overrides\n' + [...done.values()].join('\n') + '\n')
  const lines = [...done.values()]
  const count = (route, v) => lines.filter(l => l.split('\t')[1] === v && l.split('\t')[2].startsWith(route)).length
  console.log(`program: accept ${count('program', 'accept')}, reject ${count('program', 'reject')}; section: accept ${count('section', 'accept')}, reject ${count('section', 'reject')}`)
})()
