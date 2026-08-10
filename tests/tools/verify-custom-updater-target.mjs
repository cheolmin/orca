import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const roots = ['out/main', 'out/renderer']
const forbidden = [
  'https://github.com/stablyai/orca/releases.atom',
  'https://github.com/stablyai/orca/releases/download',
  'https://github.com/stablyai/orca/releases/tag'
]
const required = ['cheolmin/orca']
const hits = new Map(required.map((value) => [value, false]))
const violations = []

function inspect(directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      inspect(file)
      continue
    }
    if (!/\.(js|html)$/.test(name)) {
      continue
    }
    const source = readFileSync(file, 'utf8')
    for (const value of forbidden) {
      if (source.includes(value)) {
        violations.push(`${relative(process.cwd(), file)} contains ${value}`)
      }
    }
    for (const value of required) {
      if (source.includes(value)) {
        hits.set(value, true)
      }
    }
  }
}

for (const root of roots) {
  inspect(root)
}
for (const [value, found] of hits) {
  if (!found) {
    violations.push(`built desktop is missing ${value}`)
  }
}
if (violations.length > 0) {
  throw new Error(violations.join('\n'))
}
console.log('Custom updater targets cheolmin/orca in main and renderer bundles.')
