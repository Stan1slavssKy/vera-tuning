#!/usr/bin/env node
// What a running program asks the model, for runtime-run.js (vera-probe-distill): live figures (Vera.Live.fetch, and the
// source finder at generation) and words written for the person (Vera.Ask.text). DeepSeek writes them (not trained on).
// $ARKESTR_API_KEY.
//
//   node tools/gen-runtime.js -o prompts/batches/rtNN-runtime.tsv [-l LIVE_PER_AREA] [-a ASKS_PER_TOPIC]
//
// Output: family<TAB>label<TAB>item, the item `live<TAB>figure` or `ask<TAB>maxWords<TAB>prompt`. Ask families are the
// topics of prompts/topics.tsv (not *-none); live families are live-<area>.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const args = process.argv.slice(2)
const option = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v }
const out = option('-o', '')
const livePerArea = Number(option('-l', '15'))
const asksPerTopic = Number(option('-a', '2'))
if (!out) { console.error('usage: gen-runtime.js -o OUT.tsv [-l LIVE_PER_AREA] [-a ASKS_PER_TOPIC]'); process.exit(2) }

const AREAS = ['weather', 'money', 'markets', 'sports', 'transport', 'energy', 'space', 'health', 'travel', 'news-figures']

async function ask(system, user) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ARKESTR_API_KEY},
    body: JSON.stringify({model: 'deepseek-flash', temperature: 1.0, max_tokens: 1500, thinking: {type: 'disabled'},
      response_format: {type: 'json_object'}, messages: [{role: 'system', content: system}, {role: 'user', content: user}]})})
  const body = await res.json()
  if (!res.ok) throw Error('DeepSeek HTTP ' + res.status)
  return JSON.parse(body.choices[0].message.content)
}

const LIVE = 'You list live real-world figures a phone app could show as they are right now, each one a web search can ' +
  'find today: a price, a rate, a level, a score, a time, a count. Each is a short label naming the thing, the place or ' +
  'the unit where it matters ("Gold price per ounce in USD", "Sunset time in Lisbon today"). Reply with JSON only: {"figures": ["..."]}'
const ASK = 'You write what a phone app sends a writing model while it runs, to get words for the person from what they ' +
  'entered in the app: the prompt carries those entries ("Suggest two dinners using what is about to go off: spinach, ' +
  'eggs, rice"). Each prompt is one or two plain sentences, with concrete entries made up for the app, and a word limit ' +
  'that fits (20 to 120). Reply with JSON only: {"asks": [{"prompt": "...", "maxWords": 60}]}'

;(async () => {
  const lines = ['# family\tlabel\tkind\t... -- gen-runtime.js; runtime-run.js (vera-probe-distill) runs them']
  const clean = s => String(s).replace(/[\t\n]+/g, ' ').trim()
  for (const area of AREAS) {
    const got = await ask(LIVE, 'Area: ' + area + '. List ' + livePerArea + ' different figures.')
    ;(got.figures || []).slice(0, livePerArea).forEach((f, i) => lines.push(`live-${area}\trt-live-${area}-${String(i + 1).padStart(2, '0')}\tlive\t${clean(f)}`))
  }
  const topics = fs.readFileSync(path.join(root, 'prompts/topics.tsv'), 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t')).filter(([, status]) => !status.endsWith('-none'))
  for (const [topic, , why, ...examples] of topics) {
    const got = await ask(ASK, 'The app: ' + topic.replace(/-/g, ' ') + ' -- ' + why + ' (such as: ' + examples.filter(Boolean).join('; ') +
      '). Write ' + asksPerTopic + ' prompts, each from different entries.')
    ;(got.asks || []).slice(0, asksPerTopic).forEach((a, i) => {
      const words = Math.min(120, Math.max(20, Math.round(Number(a.maxWords) || 60)))
      if (a.prompt) lines.push(`${topic}\trt-ask-${topic}-${String(i + 1).padStart(2, '0')}\task\t${words}\t${clean(a.prompt)}`)
    })
  }
  fs.writeFileSync(out, lines.join('\n') + '\n')
  console.log(lines.length - 1, 'items written to', out)
})().catch(e => { console.error(e); process.exit(1) })
