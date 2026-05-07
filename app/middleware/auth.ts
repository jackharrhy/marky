import type { Middleware } from 'remix/fetch-router'
import { Session } from 'remix/session'

// Identity carried in the session cookie when a user has signed in via Discord.
// Persisted as the `identity` field of the session payload.
export interface IdentityValue {
  discordId: string
  name: string
  color: string
}

// Class used as a typed context key. `context.get(Identity)` returns
// `IdentityValue | null` (set by `identityMiddleware`).
export class Identity {
  private constructor() {}
  // Phantom property so TS infers the right value type for context.get.
  declare readonly __value: IdentityValue | null
}

export function identityMiddleware(): Middleware {
  return (async (context, next) => {
    let value: IdentityValue | null = null
    try {
      const session = context.get(Session)
      const stored = session.get('identity') as IdentityValue | undefined
      if (stored) value = stored
    } catch {
      // Session not in stack (anonymous mode); leave value null.
    }
    // The middleware-context generic system is too rigid for ad-hoc keys.
    // The contract that matters is the handler-side `context.get(Identity)`.
    ;(context as any).set(Identity, value)
    return next()
  }) as Middleware
}
