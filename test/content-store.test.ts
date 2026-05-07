import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { ContentStore } from '../app/data/content-store.ts'

describe('ContentStore', () => {
  let dir: string
  let store: ContentStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marky-test-'))
    store = new ContentStore({ dir })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list for an empty directory', async () => {
    assert.deepEqual(await store.list(), [])
  })

  it('returns an empty list when the directory does not exist', async () => {
    const missing = new ContentStore({ dir: path.join(dir, 'does-not-exist') })
    assert.deepEqual(await missing.list(), [])
  })

  it('lists only markdown files, sorted', async () => {
    await fs.writeFile(path.join(dir, 'b.md'), 'b')
    await fs.writeFile(path.join(dir, 'a.md'), 'a')
    await fs.writeFile(path.join(dir, 'README.txt'), 'ignored')
    assert.deepEqual(await store.list(), ['a.md', 'b.md'])
  })

  it('reads existing content', async () => {
    await fs.writeFile(path.join(dir, 'note.md'), 'hello')
    assert.equal(await store.read('note.md'), 'hello')
  })

  it('returns null for missing files', async () => {
    assert.equal(await store.read('missing.md'), null)
  })

  it('readOrCreate creates a file when missing', async () => {
    assert.equal(await store.readOrCreate('fresh.md'), '')
    assert.equal(await fs.readFile(path.join(dir, 'fresh.md'), 'utf-8'), '')
  })

  it('writes content', async () => {
    await store.write('out.md', 'persisted')
    assert.equal(await fs.readFile(path.join(dir, 'out.md'), 'utf-8'), 'persisted')
  })

  it('rejects non-markdown filenames', async () => {
    await assert.rejects(() => store.write('bad.txt', ''), /must end with \.md/)
  })

  it('rejects filenames with path separators', async () => {
    await assert.rejects(() => store.write('a/b.md', ''), /path separators/)
    await assert.rejects(() => store.write('../escape.md', ''), /path separators/)
  })

  it('rejects an empty filename', async () => {
    await assert.rejects(() => store.write('.md', ''), /empty/)
  })
})
