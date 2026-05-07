import type { BuildAction } from 'remix/fetch-router'

import { EditorPage } from '../ui/editor/editor-page.tsx'
import type { routes } from '../routes.ts'
import { render } from '../utils/render.tsx'

export const home: BuildAction<'GET', typeof routes.home> = {
  handler({ request }) {
    return render(<EditorPage />, request)
  },
}
