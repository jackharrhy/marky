# Git data layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GitStore` (a `simple-git` wrapper for staging/committing/pushing in an external repo) and extend `ContentStore` with `rename` and `remove`. Pure data layer; the application is unchanged until Plan 2 wires these in.

**Architecture:** Two new methods on existing `ContentStore`. One new `app/data/git-store.ts` module exporting a `GitStore` class. Both are unit-testable against real on-disk repos (no git network, no docker). `app/config.ts` learns about an optional `git` config block.

**Tech Stack:** `simple-git` (added as a dependency), `node:test`, `node:fs/promises`, existing `app/data/content-store.ts`.

**Reference:** `docs/superpowers/specs/2026-05-11-git-attribution-and-rename-delete-design.md` — sections "Config module changes", "`GitStore`", "`ContentStore`".

---

## File Structure

- Create: `app/data/git-store.ts`
- Create: `test/git-store.test.ts`
- Modify: `app/data/content-store.ts` (add `rename` and `remove`)
- Modify: `test/content-store.test.ts` (test the two new methods)
- Modify: `app/config.ts` (add optional `git` config)
- Modify: `test/config.test.ts` (cover git-config parsing)
- Modify: `package.json` (add `simple-git`)

`server.ts` is intentionally NOT modified in this plan. The new `GitStore` and `git` config exist but nothing instantiates them yet. Plan 2 wires them into the boot sequence.

---

### Task 1: Add `simple-git` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install simple-git**

```sh
npm i simple-git
```

This pins `simple-git@^3.36.0` (current latest) into `dependencies`.

- [ ] **Step 2: Confirm install**

```sh
node -e "console.log(require('simple-git/package.json').version)"
```

Expected: `3.36.0` (or newer compatible 3.x).

- [ ] **Step 3: Run existing checks unchanged**

```sh
npm run typecheck
npm test
```

Expected: 84/84 pass, typecheck clean.

- [ ] **Step 4: Commit**

```sh
git add package.json package-lock.json
git commit -m "deps: add simple-git"
```

---

### Task 2: Extend `ContentStore` — write failing tests for `rename`/`remove`

**Files:**
- Modify: `test/content-store.test.ts`

- [ ] **Step 1: Add tests inside the existing `describe('ContentStore', ...)` block**

Append after the existing tests, before the closing brace:

```ts
  it('renames a file on disk', async () => {
    await store.write('alpha.md', 'hello')
    await store.rename({ oldName: 'alpha.md', newName: 'beta.md' })
    assert.equal(await store.read('alpha.md'), null)
    assert.equal(await store.read('beta.md'), 'hello')
  })

  it('rejects rename when newName already exists', async () => {
    await store.write('a.md', 'one')
    await store.write('b.md', 'two')
    await assert.rejects(
      () => store.rename({ oldName: 'a.md', newName: 'b.md' }),
      /already exists/,
    )
    assert.equal(await store.read('a.md'), 'one')
    assert.equal(await store.read('b.md'), 'two')
  })

  it('rejects rename with unsafe newName', async () => {
    await store.write('a.md', 'x')
    await assert.rejects(
      () => store.rename({ oldName: 'a.md', newName: '../escape.md' }),
      /path separators/,
    )
  })

  it('rejects rename with unsafe oldName', async () => {
    await assert.rejects(
      () => store.rename({ oldName: '../escape.md', newName: 'safe.md' }),
      /path separators/,
    )
  })

  it('removes an existing file', async () => {
    await store.write('to-delete.md', 'bye')
    await store.remove('to-delete.md')
    assert.equal(await store.read('to-delete.md'), null)
  })

  it('remove is a no-op when the file is already gone', async () => {
    // First call removes it; second call must not throw.
    await store.write('once.md', '')
    await store.remove('once.md')
    await store.remove('once.md')
    assert.equal(await store.read('once.md'), null)
  })

  it('rejects remove with unsafe name', async () => {
    await assert.rejects(() => store.remove('../escape.md'), /path separators/)
  })
```

- [ ] **Step 2: Run tests and confirm they fail**

```sh
npx tsx --test --test-force-exit test/content-store.test.ts
```

Expected: failures referring to `store.rename is not a function` and `store.remove is not a function`.

---

### Task 3: Implement `ContentStore.rename` and `ContentStore.remove`

**Files:**
- Modify: `app/data/content-store.ts`

- [ ] **Step 1: Add the methods**

Append the following methods inside the `ContentStore` class, after the existing `write` method:

```ts
  async rename(args: { oldName: string; newName: string }): Promise<void> {
    assertSafeFilename(args.oldName)
    assertSafeFilename(args.newName)
    if (args.oldName === args.newName) return

    const newPath = this.filePath(args.newName)
    try {
      await fs.access(newPath)
      throw new Error(`Filename already exists: ${args.newName}`)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }

    await fs.rename(this.filePath(args.oldName), newPath)
  }

  async remove(filename: string): Promise<void> {
    assertSafeFilename(filename)
    try {
      await fs.unlink(this.filePath(filename))
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
  }
```

- [ ] **Step 2: Run the content-store tests**

```sh
npx tsx --test --test-force-exit test/content-store.test.ts
```

Expected: all tests pass (existing 10 + 7 new = 17).

- [ ] **Step 3: Run the full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 91 tests pass total (84 previous + 7 new).

- [ ] **Step 4: Commit**

```sh
git add app/data/content-store.ts test/content-store.test.ts
git commit -m "content-store: add rename and remove"
```

---

### Task 4: Extend `app/config.ts` — write failing tests for `git` config

**Files:**
- Modify: `test/config.test.ts`

- [ ] **Step 1: Append tests inside the existing `describe('loadConfig', ...)` block**

```ts
  it('does not populate git config when MARKY_GIT_REPO is unset', () => {
    const config = loadConfig({})
    assert.equal(config.git, undefined)
  })

  it('populates git config with sensible defaults when MARKY_GIT_REPO is set', () => {
    const config = loadConfig({ MARKY_GIT_REPO: '/tmp/repo' })
    assert.ok(config.git)
    assert.equal(config.git.repoDir, '/tmp/repo')
    assert.equal(config.git.authorName, 'marky-bot')
    assert.equal(config.git.authorEmail, 'marky-bot@localhost')
    assert.equal(config.git.persistIdleMs, 60_000)
    assert.equal(config.git.pushIntervalMs, 300_000)
    assert.equal(config.git.push, undefined)
  })

  it('derives the git author email from MARKY_BASE_URL host when available', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      SESSION_SECRET: 'sssh',
      MARKY_BASE_URL: 'https://marky.example.com',
      MARKY_GIT_REPO: '/tmp/repo',
    })
    assert.equal(config.git?.authorEmail, 'marky-bot@marky.example.com')
  })

  it('honors explicit MARKY_GIT_AUTHOR_NAME and MARKY_GIT_AUTHOR_EMAIL', () => {
    const config = loadConfig({
      MARKY_GIT_REPO: '/tmp/repo',
      MARKY_GIT_AUTHOR_NAME: 'Custom Bot',
      MARKY_GIT_AUTHOR_EMAIL: 'custom@example.com',
    })
    assert.equal(config.git?.authorName, 'Custom Bot')
    assert.equal(config.git?.authorEmail, 'custom@example.com')
  })

  it('parses MARKY_PERSIST_IDLE_MS and MARKY_PUSH_INTERVAL_MS as integers', () => {
    const config = loadConfig({
      MARKY_GIT_REPO: '/tmp/repo',
      MARKY_PERSIST_IDLE_MS: '5000',
      MARKY_PUSH_INTERVAL_MS: '0',
    })
    assert.equal(config.git?.persistIdleMs, 5000)
    assert.equal(config.git?.pushIntervalMs, 0)
  })

  it('rejects invalid MARKY_PERSIST_IDLE_MS', () => {
    assert.throws(
      () => loadConfig({ MARKY_GIT_REPO: '/r', MARKY_PERSIST_IDLE_MS: 'oops' }),
      /MARKY_PERSIST_IDLE_MS must be a number/,
    )
  })

  it('rejects invalid MARKY_PUSH_INTERVAL_MS', () => {
    assert.throws(
      () => loadConfig({ MARKY_GIT_REPO: '/r', MARKY_PUSH_INTERVAL_MS: 'oops' }),
      /MARKY_PUSH_INTERVAL_MS must be a number/,
    )
  })

  it('populates push.pat when MARKY_GIT_PUSH=true and MARKY_GIT_PAT is set', () => {
    const config = loadConfig({
      MARKY_GIT_REPO: '/tmp/repo',
      MARKY_GIT_PUSH: 'true',
      MARKY_GIT_PAT: 'ghp_abc',
    })
    assert.deepEqual(config.git?.push, { pat: 'ghp_abc' })
  })

  it('rejects MARKY_GIT_PUSH=true without MARKY_GIT_PAT', () => {
    assert.throws(
      () => loadConfig({ MARKY_GIT_REPO: '/tmp/repo', MARKY_GIT_PUSH: 'true' }),
      /MARKY_GIT_PUSH=true requires MARKY_GIT_PAT/,
    )
  })

  it('rejects MARKY_GIT_PAT when MARKY_GIT_REPO is unset', () => {
    assert.throws(
      () => loadConfig({ MARKY_GIT_PAT: 'ghp_abc' }),
      /MARKY_GIT_PAT requires MARKY_GIT_REPO/,
    )
  })

  it('ignores MARKY_GIT_PUSH when set to a falsy value', () => {
    const config = loadConfig({
      MARKY_GIT_REPO: '/tmp/repo',
      MARKY_GIT_PUSH: 'false',
    })
    assert.equal(config.git?.push, undefined)
  })
```

- [ ] **Step 2: Run the config tests, expect failures**

```sh
npx tsx --test --test-force-exit test/config.test.ts
```

Expected: most tests fail because `config.git` is undefined / the type doesn't include `git`.

---

### Task 5: Implement `git` config in `app/config.ts`

**Files:**
- Modify: `app/config.ts`

- [ ] **Step 1: Read the current file to anchor the edit**

```sh
cat app/config.ts
```

Confirm `AppConfig` currently has `auth`, `port`, `contentDir`. The edit adds an optional `git` field plus a `loadGitConfig(env, baseUrl)` helper.

- [ ] **Step 2: Replace `app/config.ts` with the extended version**

```ts
import * as path from 'node:path'

// Typed env-derived configuration. Read once at startup via loadConfig() so
// failures surface before the server binds a port.

export interface DiscordAuthConfig {
  mode: 'discord'
  clientId: string
  clientSecret: string
  guildId: string
  baseUrl: string
  sessionSecret: string
  botToken?: string
}

export type AuthConfig = { mode: 'anonymous' } | DiscordAuthConfig

export interface GitConfig {
  repoDir: string
  authorName: string
  authorEmail: string
  persistIdleMs: number
  pushIntervalMs: number
  push?: { pat: string }
}

export interface AppConfig {
  auth: AuthConfig
  port: number
  contentDir: string
  git?: GitConfig
}

const DEFAULT_PORT = 44100
const DEFAULT_PERSIST_IDLE_MS = 60_000
const DEFAULT_PUSH_INTERVAL_MS = 300_000

const DISCORD_REQUIRED = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_GUILD_ID',
  'SESSION_SECRET',
] as const

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.MARKY_AUTH ?? 'anonymous'
  if (mode !== 'anonymous' && mode !== 'discord') {
    throw new Error(`MARKY_AUTH must be "anonymous" or "discord", got "${mode}"`)
  }

  const port = parsePort(env.PORT)
  const auth: AuthConfig =
    mode === 'anonymous' ? { mode: 'anonymous' } : loadDiscordConfig(env, port)
  const baseUrl = auth.mode === 'discord' ? auth.baseUrl : null

  return {
    auth,
    port,
    contentDir: parseContentDir(env.MARKY_CONTENT_DIR),
    git: loadGitConfig(env, baseUrl),
  }
}

function loadDiscordConfig(
  env: Record<string, string | undefined>,
  port: number,
): DiscordAuthConfig {
  const missing = DISCORD_REQUIRED.filter((key) => !env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `MARKY_AUTH=discord requires the following env vars: ${missing.join(', ')}`,
    )
  }

  const rawBaseUrl = env.MARKY_BASE_URL?.trim()
  const baseUrl = (rawBaseUrl || `http://localhost:${port}`).replace(/\/+$/, '')

  return {
    mode: 'discord',
    clientId: env.DISCORD_CLIENT_ID!.trim(),
    clientSecret: env.DISCORD_CLIENT_SECRET!.trim(),
    guildId: env.DISCORD_GUILD_ID!.trim(),
    baseUrl,
    sessionSecret: env.SESSION_SECRET!.trim(),
    botToken: env.DISCORD_BOT_TOKEN?.trim() || undefined,
  }
}

function loadGitConfig(
  env: Record<string, string | undefined>,
  baseUrl: string | null,
): GitConfig | undefined {
  const repoDir = env.MARKY_GIT_REPO?.trim()
  const pat = env.MARKY_GIT_PAT?.trim()
  const pushFlag = env.MARKY_GIT_PUSH?.trim()

  if (!repoDir) {
    if (pat) {
      throw new Error('MARKY_GIT_PAT requires MARKY_GIT_REPO to be set')
    }
    return undefined
  }

  const authorName = env.MARKY_GIT_AUTHOR_NAME?.trim() || 'marky-bot'
  const authorEmail =
    env.MARKY_GIT_AUTHOR_EMAIL?.trim() || `marky-bot@${hostFromBaseUrl(baseUrl)}`

  const persistIdleMs = parseInteger(env.MARKY_PERSIST_IDLE_MS, DEFAULT_PERSIST_IDLE_MS, 'MARKY_PERSIST_IDLE_MS')
  const pushIntervalMs = parseInteger(
    env.MARKY_PUSH_INTERVAL_MS,
    DEFAULT_PUSH_INTERVAL_MS,
    'MARKY_PUSH_INTERVAL_MS',
  )

  let push: { pat: string } | undefined
  if (pushFlag === 'true') {
    if (!pat) throw new Error('MARKY_GIT_PUSH=true requires MARKY_GIT_PAT')
    push = { pat }
  }

  return { repoDir, authorName, authorEmail, persistIdleMs, pushIntervalMs, push }
}

function hostFromBaseUrl(baseUrl: string | null): string {
  if (!baseUrl) return 'localhost'
  try {
    return new URL(baseUrl).hostname || 'localhost'
  } catch {
    return 'localhost'
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`PORT must be a number, got "${raw}"`)
  }
  return parsed
}

function parseInteger(raw: string | undefined, fallback: number, varName: string): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`${varName} must be a number, got "${raw}"`)
  }
  return parsed
}

function parseContentDir(raw: string | undefined): string {
  return path.resolve(raw && raw.length > 0 ? raw : path.join(process.cwd(), 'content'))
}
```

- [ ] **Step 3: Run the config tests, expect pass**

```sh
npx tsx --test --test-force-exit test/config.test.ts
```

Expected: 23 tests pass (13 existing config tests + 10 new git-config tests).

- [ ] **Step 4: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 101 tests pass total (91 previous + 10 new).

- [ ] **Step 5: Commit**

```sh
git add app/config.ts test/config.test.ts
git commit -m "config: add optional git config block"
```

---

### Task 6: Implement `GitStore` — write failing tests

**Files:**
- Create: `test/git-store.test.ts`

This test file initializes a real git repo in a temp dir, makes a seed commit, then exercises `GitStore` against it. No mocking of git itself; we want real-git behavior locked in.

- [ ] **Step 1: Write the test file**

```ts
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { simpleGit } from 'simple-git'

import { GitStore } from '../app/data/git-store.ts'

// Each test runs against a fresh temp repo with a single seed commit so
// that staging operations have meaningful diffs. We use real `git` (the
// binary that ships with the test runner host) via simple-git; this
// matches production where simple-git runs the same way.
async function freshRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marky-git-test-'))
  const git = simpleGit(dir)
  await git.init()
  await git
    .addConfig('user.name', 'Seed', undefined, 'local')
    .addConfig('user.email', 'seed@example.com', undefined, 'local')
  await fs.mkdir(path.join(dir, 'content'), { recursive: true })
  await fs.writeFile(path.join(dir, 'content', 'seed.md'), 'seed\n')
  await git.add(['content/seed.md'])
  await git.commit('seed')
  return dir
}

function newStore(repoDir: string) {
  return new GitStore({
    repoDir,
    authorName: 'marky-bot',
    authorEmail: 'marky-bot@test',
  })
}

describe('GitStore', () => {
  let repoDir: string

  beforeEach(async () => {
    repoDir = await freshRepo()
  })

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true })
  })

  it('assertRepo succeeds on a real repo', async () => {
    const store = newStore(repoDir)
    await store.assertRepo()
  })

  it('assertRepo throws on a non-repo directory', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'marky-not-a-repo-'))
    try {
      const store = newStore(empty)
      await assert.rejects(() => store.assertRepo(), /not a git repository/)
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it('stageEdit + commit produces a new HEAD with the right author and message', async () => {
    const store = newStore(repoDir)
    await fs.writeFile(path.join(repoDir, 'content', 'alpha.md'), 'hello\n')
    await store.stageEdit({ path: 'content/alpha.md' })
    const result = await store.commit('edit alpha.md — jackharrhy')
    assert.ok(result)
    assert.match(result.sha, /^[0-9a-f]{40}$/)

    const git = simpleGit(repoDir)
    const log = await git.log({ maxCount: 1 })
    assert.equal(log.latest?.message, 'edit alpha.md — jackharrhy')
    assert.equal(log.latest?.author_name, 'marky-bot')
    assert.equal(log.latest?.author_email, 'marky-bot@test')
  })

  it('commit returns null when there is nothing staged', async () => {
    const store = newStore(repoDir)
    const result = await store.commit('edit nothing.md — nobody')
    assert.equal(result, null)
  })

  it('stageRename + commit records the move', async () => {
    const store = newStore(repoDir)
    await store.stageRename({
      oldPath: 'content/seed.md',
      newPath: 'content/renamed.md',
    })
    await store.commit('rename seed.md → renamed.md — jackharrhy')

    const git = simpleGit(repoDir)
    const summary = await git.raw(['diff-tree', '--name-status', '-r', '-M', 'HEAD'])
    assert.match(summary, /^R\d+\tcontent\/seed\.md\tcontent\/renamed\.md/m)
  })

  it('stageDelete + commit records the deletion', async () => {
    const store = newStore(repoDir)
    await store.stageDelete({ path: 'content/seed.md' })
    await store.commit('delete seed.md — jackharrhy')

    const git = simpleGit(repoDir)
    const summary = await git.raw(['diff-tree', '--name-status', '-r', 'HEAD'])
    assert.match(summary, /^D\tcontent\/seed\.md/m)
  })

  it('does not modify the repo .git/config (per-commit identity flags)', async () => {
    const store = newStore(repoDir)
    await fs.writeFile(path.join(repoDir, 'content', 'a.md'), 'x')
    await store.stageEdit({ path: 'content/a.md' })
    await store.commit('edit a.md — jackharrhy')

    const git = simpleGit(repoDir)
    const localName = (await git.raw(['config', '--local', 'user.name'])).trim()
    const localEmail = (await git.raw(['config', '--local', 'user.email'])).trim()
    assert.equal(localName, 'Seed')
    assert.equal(localEmail, 'seed@example.com')
  })

  it('hasUnpushed is true when there are commits without an upstream', async () => {
    const store = newStore(repoDir)
    await fs.writeFile(path.join(repoDir, 'content', 'a.md'), 'x')
    await store.stageEdit({ path: 'content/a.md' })
    await store.commit('edit a.md — jackharrhy')
    assert.equal(await store.hasUnpushed(), true)
  })

  it('hasUnpushed is false on a clean repo whose upstream tracks HEAD', async () => {
    // Bare upstream to give the branch something to track.
    const upstream = await fs.mkdtemp(path.join(os.tmpdir(), 'marky-upstream-'))
    try {
      await simpleGit(upstream).init(true)
      const git = simpleGit(repoDir)
      await git.addRemote('origin', upstream)
      await git.push(['-u', 'origin', 'HEAD'])

      const store = newStore(repoDir)
      assert.equal(await store.hasUnpushed(), false)
    } finally {
      await fs.rm(upstream, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the tests, expect failures**

```sh
npx tsx --test --test-force-exit test/git-store.test.ts
```

Expected: every test fails because `app/data/git-store.ts` doesn't exist yet.

---

### Task 7: Implement `GitStore`

**Files:**
- Create: `app/data/git-store.ts`

- [ ] **Step 1: Write the module**

```ts
import { simpleGit, type SimpleGit } from 'simple-git'

// `GitStore` is a thin wrapper around simple-git that keeps marky's git
// operations small, explicit, and free of side effects on the repo's
// existing config. Per-commit identity flags are passed via the
// per-call `-c user.name`/`-c user.email` arguments rather than mutating
// `.git/config` so a human contributor's local config stays untouched.

export interface GitStoreOptions {
  repoDir: string
  authorName: string
  authorEmail: string
  push?: { pat: string }
}

export interface CommitResult {
  sha: string
}

export class GitStore {
  private readonly git: SimpleGit
  private readonly repoDir: string
  private readonly authorName: string
  private readonly authorEmail: string
  private readonly pushPat?: string

  constructor(options: GitStoreOptions) {
    this.repoDir = options.repoDir
    this.authorName = options.authorName
    this.authorEmail = options.authorEmail
    this.pushPat = options.push?.pat
    this.git = simpleGit({ baseDir: this.repoDir })
  }

  async assertRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo()
    if (!isRepo) {
      throw new Error(`${this.repoDir} is not a git repository`)
    }
  }

  async stageEdit(args: { path: string }): Promise<void> {
    await this.git.add([args.path])
  }

  async stageRename(args: { oldPath: string; newPath: string }): Promise<void> {
    // The new file is already on disk via ContentStore.rename; simple-git
    // refuses `git mv` once the source is gone, so use `git add` on the
    // new path and `git rm` on the old path. The resulting diff still
    // shows as a rename when git's similarity detection runs (-M).
    await this.git.add([args.newPath])
    await this.git.rm([args.oldPath])
  }

  async stageDelete(args: { path: string }): Promise<void> {
    // `git rm` here also removes the on-disk file. ContentStore.remove
    // may have already done so; pass --ignore-unmatch to be defensive
    // against the file being gone or untracked.
    await this.git.raw(['rm', '-f', '--ignore-unmatch', '--', args.path])
  }

  async commit(message: string): Promise<CommitResult | null> {
    // Look at the staged index only — unstaged edits in the working tree
    // do not produce a commit even though we're using `git commit` (no
    // `-a`). If nothing is staged, simple-git returns a commit object
    // with empty `commit` and `summary.changes === 0`; treat that as
    // "nothing to commit" and return null.
    const result = await this.git.commit(message, {
      '--author': `${this.authorName} <${this.authorEmail}>`,
    })
    if (!result.commit) return null
    return { sha: result.commit }
  }

  async hasUnpushed(): Promise<boolean> {
    // `git rev-list --count @{u}..HEAD` returns the number of commits
    // ahead of the upstream. If there is no upstream configured the
    // command errors; treat that as "has unpushed" so a first push will
    // happen when configured.
    try {
      const count = await this.git.raw(['rev-list', '--count', '@{u}..HEAD'])
      return Number.parseInt(count.trim(), 10) > 0
    } catch {
      return true
    }
  }

  async push(): Promise<void> {
    // If a PAT is provided, inject it into the origin URL for the
    // duration of this single push. Never write the credential back to
    // the repo config or remote URL.
    if (!this.pushPat) {
      await this.git.push()
      return
    }

    const remotes = await this.git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    if (!origin) {
      throw new Error('GitStore.push: no origin remote configured')
    }
    const authenticatedUrl = injectPat(origin.refs.push || origin.refs.fetch, this.pushPat)
    if (!authenticatedUrl) {
      // Non-HTTPS origin (likely SSH); fall through to plain push.
      await this.git.push()
      return
    }
    await this.git.push(authenticatedUrl, 'HEAD')
  }
}

function injectPat(url: string, pat: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    u.username = 'x-access-token'
    u.password = pat
    return u.toString()
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Run the GitStore tests, expect pass**

```sh
npx tsx --test --test-force-exit test/git-store.test.ts
```

Expected: 9 tests pass.

If any test fails because the host doesn't have `git` on PATH, that's a real prerequisite — install git and re-run. (CI's `node:24-trixie-slim` image already has git via the npm install path; locally on macOS, `xcode-select --install` provides it.)

- [ ] **Step 3: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 110 tests pass total (101 previous + 9 new).

- [ ] **Step 4: Commit**

```sh
git add app/data/git-store.ts test/git-store.test.ts
git commit -m "data: add GitStore wrapper around simple-git"
```

---

### Task 8: Asset-server denies the new module

**Files:**
- Modify: `test/routes.test.ts`

`app/assets.ts` already denies `app/data/**` from being served as browser assets. Add a test that confirms the new `git-store.ts` is denied alongside `discord.ts`.

- [ ] **Step 1: Append to `describe('routes', ...)` in `test/routes.test.ts`**

Locate the existing `it('asset route denies app/data/discord.ts', ...)` and append immediately after it:

```ts
  it('asset route denies app/data/git-store.ts', async () => {
    const url = 'http://localhost' + routes.assets.href({ path: 'app/data/git-store.ts' })
    const response = await router.fetch(new Request(url))
    assert.notEqual(response.status, 200)
  })
```

- [ ] **Step 2: Run routes tests**

```sh
npx tsx --test --test-force-exit test/routes.test.ts
```

Expected: existing tests still pass plus the new one.

- [ ] **Step 3: Run full suite + typecheck**

```sh
npm run typecheck
npm test
```

Expected: 111 tests pass.

- [ ] **Step 4: Commit**

```sh
git add test/routes.test.ts
git commit -m "test: deny app/data/git-store.ts from asset routes"
```

---

## Plan-end verification

- [ ] Full test suite + typecheck

```sh
npm run typecheck
npm test
```

Both exit 0. Test count: 111.

- [ ] Server still boots and serves anonymous mode

```sh
PORT=44900 npx tsx server.ts &
sleep 3
curl -s -o /dev/null -w "STATUS=%{http_code}\n" http://localhost:44900/
kill %1 2>/dev/null
```

Expected: STATUS=200.

After this plan: `GitStore` and the two new `ContentStore` methods exist and are fully tested, but nothing in the application calls them yet. Anonymous mode boots; discord mode boots. The new `git` config block parses correctly but the codebase doesn't read it. Plan 2 wires everything into `SocketRoom` and `server.ts`.
