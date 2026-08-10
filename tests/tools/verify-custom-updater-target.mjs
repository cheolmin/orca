import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const roots = ['out/main', 'out/renderer']
const forbidden = [
  'https://github.com/stablyai/orca/releases.atom',
  'https://github.com/stablyai/orca/releases/latest/download',
  'https://github.com/stablyai/orca/releases/tag'
]
const requiredByRoot = new Map(roots.map((root) => [root, false]))
const violations = []

function inspect(root, directory) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      inspect(root, file)
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
    if (source.includes('cheolmin/orca')) {
      requiredByRoot.set(root, true)
    }
  }
}

for (const root of roots) {
  inspect(root, root)
}
for (const [root, found] of requiredByRoot) {
  if (!found) {
    violations.push(`${root} is missing cheolmin/orca`)
  }
}
if (violations.length > 0) {
  throw new Error(violations.join('\n'))
}
console.log('Custom updater targets cheolmin/orca in main and renderer bundles.')
