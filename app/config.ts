import * as path from 'node:path'

// Typed env-derived configuration. Read once at startup via loadConfig() so
// failures surface before the server binds a port.

export type AuthConfig =
  | { mode: 'anonymous' }
  | {
      mode: 'discord'
      clientId: string
      clientSecret: string
      guildId: string
      baseUrl: string
      sessionSecret: string
      botToken?: string
    }

export interface AppConfig {
  auth: AuthConfig
  port: number
  contentDir: string
}

const DEFAULT_PORT = 44100

const DISCORD_REQUIRED = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_GUILD_ID',
  'MARKY_BASE_URL',
  'SESSION_SECRET',
] as const

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.MARKY_AUTH ?? 'anonymous'
  if (mode !== 'anonymous' && mode !== 'discord') {
    throw new Error(`MARKY_AUTH must be "anonymous" or "discord", got "${mode}"`)
  }

  return {
    auth: mode === 'anonymous' ? { mode: 'anonymous' } : loadDiscordConfig(env),
    port: parsePort(env.PORT),
    contentDir: parseContentDir(env.MARKY_CONTENT_DIR),
  }
}

function loadDiscordConfig(env: Record<string, string | undefined>): AuthConfig {
  const missing = DISCORD_REQUIRED.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(
      `MARKY_AUTH=discord requires the following env vars: ${missing.join(', ')}`,
    )
  }

  const baseUrl = env.MARKY_BASE_URL!.replace(/\/+$/, '')

  return {
    mode: 'discord',
    clientId: env.DISCORD_CLIENT_ID!,
    clientSecret: env.DISCORD_CLIENT_SECRET!,
    guildId: env.DISCORD_GUILD_ID!,
    baseUrl,
    sessionSecret: env.SESSION_SECRET!,
    botToken: env.DISCORD_BOT_TOKEN || undefined,
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

function parseContentDir(raw: string | undefined): string {
  return path.resolve(raw && raw.length > 0 ? raw : path.join(process.cwd(), 'content'))
}
