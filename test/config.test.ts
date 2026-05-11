import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadConfig } from '../app/config.ts'

describe('loadConfig', () => {
  it('defaults to anonymous mode when MARKY_AUTH is unset', () => {
    const config = loadConfig({})
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('treats MARKY_AUTH=anonymous as anonymous mode', () => {
    const config = loadConfig({ MARKY_AUTH: 'anonymous' })
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('rejects unknown MARKY_AUTH values', () => {
    assert.throws(
      () => loadConfig({ MARKY_AUTH: 'github' }),
      /MARKY_AUTH must be "anonymous" or "discord"/,
    )
  })

  it('ignores Discord vars in anonymous mode', () => {
    const config = loadConfig({
      MARKY_AUTH: 'anonymous',
      DISCORD_CLIENT_ID: 'leftover',
      DISCORD_CLIENT_SECRET: 'leftover',
    })
    assert.equal(config.auth.mode, 'anonymous')
  })

  it('parses discord mode with all required vars', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com',
      SESSION_SECRET: 'sssh',
    })
    assert.equal(config.auth.mode, 'discord')
    if (config.auth.mode !== 'discord') throw new Error('unreachable')
    assert.equal(config.auth.clientId, 'cid')
    assert.equal(config.auth.clientSecret, 'csecret')
    assert.equal(config.auth.guildId, 'gid')
    assert.equal(config.auth.baseUrl, 'https://marky.example.com')
    assert.equal(config.auth.sessionSecret, 'sssh')
    assert.equal(config.auth.botToken, undefined)
  })

  it('captures the optional bot token in discord mode', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com',
      SESSION_SECRET: 'sssh',
      DISCORD_BOT_TOKEN: 'bot',
    })
    assert.equal(config.auth.mode === 'discord' && config.auth.botToken, 'bot')
  })

  it('lists every missing required var in discord mode', () => {
    assert.throws(
      () => loadConfig({ MARKY_AUTH: 'discord' }),
      (error: Error) => {
        assert.match(error.message, /DISCORD_CLIENT_ID/)
        assert.match(error.message, /DISCORD_CLIENT_SECRET/)
        assert.match(error.message, /DISCORD_GUILD_ID/)
        assert.match(error.message, /SESSION_SECRET/)
        assert.doesNotMatch(error.message, /MARKY_BASE_URL/)
        return true
      },
    )
  })

  it('defaults MARKY_BASE_URL to http://localhost:<port> when unset', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      SESSION_SECRET: 'sssh',
    })
    if (config.auth.mode !== 'discord') throw new Error('unreachable')
    assert.equal(config.auth.baseUrl, 'http://localhost:44100')
  })

  it('uses the configured PORT in the default MARKY_BASE_URL', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      PORT: '8080',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      SESSION_SECRET: 'sssh',
    })
    if (config.auth.mode !== 'discord') throw new Error('unreachable')
    assert.equal(config.auth.baseUrl, 'http://localhost:8080')
  })

  it('strips trailing slash from MARKY_BASE_URL', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: 'cid',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: 'https://marky.example.com/',
      SESSION_SECRET: 'sssh',
    })
    assert.equal(config.auth.mode === 'discord' && config.auth.baseUrl, 'https://marky.example.com')
  })

  it('parses PORT and MARKY_CONTENT_DIR with sensible defaults', () => {
    const config = loadConfig({})
    assert.equal(config.port, 44100)
    assert.equal(typeof config.contentDir, 'string')
    assert.ok(config.contentDir.endsWith('content'))
  })

  it('parses a custom PORT', () => {
    const config = loadConfig({ PORT: '8080' })
    assert.equal(config.port, 8080)
  })

  it('rejects an invalid PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-number' }), /PORT must be a number/)
  })

  it('treats whitespace-only discord vars as missing', () => {
    assert.throws(
      () =>
        loadConfig({
          MARKY_AUTH: 'discord',
          DISCORD_CLIENT_ID: '   ',
          DISCORD_CLIENT_SECRET: '\t',
          DISCORD_GUILD_ID: 'gid',
          MARKY_BASE_URL: 'https://marky.example.com',
          SESSION_SECRET: 'sssh',
        }),
      (error: Error) => {
        assert.match(error.message, /DISCORD_CLIENT_ID/)
        assert.match(error.message, /DISCORD_CLIENT_SECRET/)
        assert.doesNotMatch(error.message, /DISCORD_GUILD_ID/)
        return true
      },
    )
  })

  it('trims whitespace from discord values', () => {
    const config = loadConfig({
      MARKY_AUTH: 'discord',
      DISCORD_CLIENT_ID: '  cid  ',
      DISCORD_CLIENT_SECRET: 'csecret',
      DISCORD_GUILD_ID: 'gid',
      MARKY_BASE_URL: '  https://marky.example.com/  ',
      SESSION_SECRET: 'sssh',
      DISCORD_BOT_TOKEN: '   ',
    })
    if (config.auth.mode !== 'discord') throw new Error('unreachable')
    assert.equal(config.auth.clientId, 'cid')
    assert.equal(config.auth.baseUrl, 'https://marky.example.com')
    assert.equal(config.auth.botToken, undefined)
  })
})
