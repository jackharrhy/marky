import type { BuildAction } from 'remix/fetch-router'
import { redirect } from 'remix/response/redirect'

import { Identity, type IdentityValue } from '../middleware/auth.ts'
import { EditorPage } from '../ui/editor/editor-page.tsx'
import type { routes } from '../routes.ts'
import { render } from '../utils/render.tsx'

export const home: BuildAction<'GET', typeof routes.home> = {
  handler({ request, get, has }) {
    // Anonymous mode: identity middleware was never registered, so the
    // Identity context key isn't present.
    if (!has(Identity)) {
      return render(<EditorPage authMode={{ mode: 'anonymous' }} />, request)
    }

    // Discord mode: middleware ran. `null` means "no session yet"; an
    // identity object means the user signed in.
    const identity = (get as any)(Identity) as IdentityValue | null
    if (!identity) {
      return redirect('/auth/sign-in')
    }

    // Strip discordId at the boundary — the editor only needs name + color,
    // and we don't want the user id in the SSR'd hydration payload.
    return render(
      <EditorPage
        authMode={{
          mode: 'discord',
          identity: { name: identity.name, color: identity.color },
        }}
      />,
      request,
    )
  },
}
