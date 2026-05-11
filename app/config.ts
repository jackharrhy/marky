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
  'SESSION_SECRET',
] as const

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = env.MARKY_AUTH ?? 'anonymous'
  if (mode !== 'anonymous' && mode !== 'discord') {
    throw new Error(`MARKY_AUTH must be "anonymous" or "discord", got "${mode}"`)
  }

  const port = parsePort(env.PORT)

  return {
    auth: mode === 'anonymous' ? { mode: 'anonymous' } : loadDiscordConfig(env, port),
    port,
    contentDir: parseContentDir(env.MARKY_CONTENT_DIR),
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

  // MARKY_BASE_URL is optional; default to http://localhost:<PORT> for local dev.
  // Production deployments behind a real hostname need to set it explicitly.
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
