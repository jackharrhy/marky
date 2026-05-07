import * as crypto from 'node:crypto'

import type { BuildAction } from 'remix/fetch-router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import type { DiscordAuthConfig } from '../../config.ts'
import {
  deterministicPaletteColor,
  exchangeCode,
  fetchGuildMember,
  fetchGuildRoles,
  resolveDisplayName,
  resolveRoleColor,
} from '../../data/discord.ts'
import type { IdentityValue } from '../../middleware/auth.ts'
import { routes } from '../../routes.ts'
import { render } from '../../utils/render.tsx'
import { NotInGuildPage } from './not-in-guild-page.tsx'

const STATE_KEY = 'oauth.state'
const IDENTITY_KEY = 'identity'

export interface AuthControllerDeps {
  auth: DiscordAuthConfig
}

export interface AuthActions {
  signIn: BuildAction<'GET', typeof routes.auth.signIn>
  callback: BuildAction<'GET', typeof routes.auth.callback>
  signOut: BuildAction<'POST', typeof routes.auth.signOut>
}

export function createAuthController(deps: AuthControllerDeps): AuthActions {
  const redirectUri = `${deps.auth.baseUrl}/auth/callback`

  const signIn: BuildAction<'GET', typeof routes.auth.signIn> = {
    handler({ get }) {
      const session = get(Session)
      const state = crypto.randomBytes(32).toString('hex')
      session.set(STATE_KEY, state)

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: deps.auth.clientId,
        scope: 'identify guilds.members.read',
        redirect_uri: redirectUri,
        state,
        prompt: 'none',
      })
      return redirect(`https://discord.com/api/oauth2/authorize?${params}`)
    },
  }

  const callback: BuildAction<'GET', typeof routes.auth.callback> = {
    async handler({ get, request }) {
      const session = get(Session)
      const url = new URL(request.url)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const expected = session.get(STATE_KEY) as string | undefined
      session.unset(STATE_KEY)

      if (!code || !state || !expected || state !== expected) {
        return new Response('OAuth state mismatch, please try signing in again.', {
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      let exchange
      try {
        exchange = await exchangeCode({
          clientId: deps.auth.clientId,
          clientSecret: deps.auth.clientSecret,
          code,
          redirectUri,
        })
      } catch (error) {
        console.error('marky: token exchange failed', error)
        return new Response('Discord sign-in failed. Please try again.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      let member
      try {
        member = await fetchGuildMember({
          accessToken: exchange.accessToken,
          guildId: deps.auth.guildId,
        })
      } catch (error) {
        console.error('marky: guild-member fetch failed', error)
        return new Response('Discord sign-in failed. Please try again.', {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      if (!member) {
        return render(<NotInGuildPage />, request, { status: 403 })
      }

      const name = resolveDisplayName(member)
      let color: string | null = null
      if (deps.auth.botToken) {
        try {
          const roles = await fetchGuildRoles({
            botToken: deps.auth.botToken,
            guildId: deps.auth.guildId,
          })
          color = resolveRoleColor(member.roleIds, roles)
        } catch (error) {
          console.error('marky: roles fetch failed; falling back to palette', error)
        }
      }
      if (!color) color = deterministicPaletteColor(member.user.id)

      const identity: IdentityValue = {
        discordId: member.user.id,
        name,
        color,
      }
      session.set(IDENTITY_KEY, identity)
      session.regenerateId(true)

      return redirect(routes.home.href())
    },
  }

  const signOut: BuildAction<'POST', typeof routes.auth.signOut> = {
    handler({ get }) {
      const session = get(Session)
      session.unset(IDENTITY_KEY)
      session.regenerateId(true)
      return redirect(routes.home.href())
    },
  }

  return { signIn, callback, signOut }
}
