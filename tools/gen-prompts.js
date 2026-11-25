#!/usr/bin/env node
// More prompts for the topics that give holes: DeepSeek writes them from each topic's examples, none repeating a prompt
// already in prompts/batches/. $ARKESTR_API_KEY.
//
//   node tools/gen-prompts.js -n PER_TOPIC -o prompts/batches/bNN-name.tsv [topic ...]
//
// Topics come from prompts/topics.tsv; those marked *-none are skipped. Output: family<TAB>label<TAB>prompt.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..')
const args = process.argv.slice(2)
const option = (flag, fallback) => { const i = args.indexOf(flag); if (i < 0) return fallback; const v = args[i + 1]; args.splice(i, 2); return v }
const perTopic = Number(option('-n', '8'))
const out = option('-o', '')
if (!out) { console.error('usage: gen-prompts.js -n PER_TOPIC -o OUT.tsv [topic ...]'); process.exit(2) }

const topics = fs.readFileSync(path.join(root, 'prompts/topics.tsv'), 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'))
  .filter(([topic, status]) => !status.endsWith('-none') && (!args.length || args.includes(topic)))
const batches = path.join(root, 'prompts/batches')
const existing = fs.readdirSync(batches).filter(f => f.endsWith('.tsv')).flatMap(f => fs.readFileSync(path.join(batches, f), 'utf8')
  .split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t')))
const norm = p => p.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ')
const seen = new Set(existing.map(r => norm(r[r.length - 1])))
const used = new Map()
for (const r of existing) { const m = /-(\d+)$/.exec(r[1] || ''); if (m) used.set(r[0], Math.max(used.get(r[0]) || 0, Number(m[1]))) }

const SYSTEM = 'You write requests people type into an app maker on their phone, to get a small app made. Each is 3 to 7 ' +
  'words of plain English, lower case, the way people type: no names of real people, no brands, no punctuation at the end. ' +
  'Every one asks for the same kind of app as the examples -- the same thing to do, on a different subject or with a ' +
  'different twist -- never a different kind of app. All different from each other and from the examples. ' +
  'Reply with JSON only: {"prompts": ["...", "..."]}'

async function ask(topic, why, examples) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ARKESTR_API_KEY},
    body: JSON.stringify({model: 'deepseek-flash', temperature: 1.0, max_tokens: 800, thinking: {type: 'disabled'},
      response_format: {type: 'json_object'}, messages: [{role: 'system', content: SYSTEM},
        {role: 'user', content: 'Kind of app: ' + topic.replace(/-/g, ' ') + ' (' + why + ')\nExamples: ' + examples.join('; ') +
          '\nWrite ' + Math.round(perTopic * 1.5) + ' requests.'}]})})
  const body = await res.json()
  if (!res.ok) throw Error('DeepSeek HTTP ' + res.status)
  return JSON.parse(body.choices[0].message.content).prompts || []
}

;(async () => {
  const lines = ['# family\tlabel\tprompt -- written by tools/gen-prompts.js from prompts/topics.tsv']
  for (const [topic, , why, a, b] of topics) {
    const got = await ask(topic, why, [a, b])
    let n = used.get(topic) || 0, kept = 0
    for (const p of got) {
      const text = String(p).trim().toLowerCase().replace(/[.!?]+$/, '')
      const words = text.split(/\s+/).length
      if (kept >= perTopic || words < 2 || words > 9 || seen.has(norm(text)) || /\t/.test(text)) continue
      seen.add(norm(text))
      lines.push(`${topic}\t${topic}-${String(++n).padStart(3, '0')}\t${text}`)
      kept++
    }
    console.log(topic.padEnd(16), kept)
  }
  fs.writeFileSync(out, lines.join('\n') + '\n')
})()
