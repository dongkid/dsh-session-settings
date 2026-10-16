/**
 * Test entry point.
 *
 * Node 24 treats a positional argument to --test as a module path, not a
 * directory to scan, and its default discovery patterns do not include
 * *.spec.mjs. This index is what makes the directory argument work:
 *
 *   pnpm test                   (package.json: node --test tests/)
 *   node --test tests/          (the directory resolves to this file)
 *   node --test "tests/*.spec.mjs"
 *
 * NOT bare "node --test": with no path it only discovers the default patterns
 * (*.test.mjs, *-test.mjs, test/**, ...), finds none of the *.spec.mjs suites
 * here, and exits 0 with "tests 0 / pass 0" — a green run that tested nothing.
 *
 * Every *.spec.mjs next to this file is imported, so a new suite from any
 * writer is picked up without touching this file.
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const suites = readdirSync(here).filter(entry => entry.endsWith('.spec.mjs')).sort()

for (const suite of suites) await import(new URL(suite, import.meta.url).href)
