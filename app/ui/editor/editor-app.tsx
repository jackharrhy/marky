import { clientEntry, css, on, ref, type Handle, type SerializableProps } from 'remix/ui'
import * as Y from 'yjs'

import { CollaborativeEditor } from '../../frontend/collaborative-editor.ts'
import { SocketHandler, type AwarenessClientState } from '../../frontend/socket-handler.ts'
import { getUser, type User } from '../../frontend/user.ts'
import { MARKDOWN_EXTENSION } from '../../shared/constants.ts'

export interface EditorAppProps extends SerializableProps {
  authMode:
    | { mode: 'anonymous' }
    | { mode: 'discord'; identity: { name: string; color: string } }
}

// `EditorApp` owns everything browser-side: the websocket, the editor view,
// the file list, awareness presence, and persistence. It server-renders an
// empty shell so the page paints fast, then hydrates here.
export const EditorApp = clientEntry(
  '/assets/app/ui/editor/editor-app.tsx#EditorApp',
  function EditorApp(handle: Handle<EditorAppProps>) {
    // Setup runs on the server during SSR and again during hydration. Anything
    // that touches `window`, `localStorage`, or opens a websocket has to wait
    // until we know we are in the browser.
    const isBrowser = typeof window !== 'undefined'

    let user: User | null = null
    let socket: SocketHandler | null = null
    let editor: CollaborativeEditor | null = null
    let editorElement: HTMLElement | null = null
    let newFileInput: HTMLInputElement | null = null

    let files: string[] = []
    let currentFilename: string | null = null
    let editorMountedFor: string | null = null
    let awarenessStates = new Map<number, AwarenessClientState>()

    function refresh(): void {
      handle.update().catch(() => {
        // Ignore update errors — they fire on the first hydration tick.
      })
    }

    function mountEditorIfReady(filename: string): void {
      if (!socket) return
      const subdoc = socket.getSubdoc(filename)
      const awareness = socket.getSubdocAwareness(filename)
      if (!subdoc || !awareness) return
      if (editorMountedFor === filename && editor) return

      if (editor) {
        editor.switchToSubdoc(subdoc, awareness)
      } else {
        editor = new CollaborativeEditor({ subdoc, awareness })
      }
      editorMountedFor = filename
      if (editorElement) editor.mount(editorElement)
    }

    function openFile(filename: string): void {
      if (!socket) return
      currentFilename = filename
      editorMountedFor = null
      socket.setCurrentFile(filename)
      socket.openFile(filename)
      refresh()
    }

    function createFile(): void {
      const raw = newFileInput?.value.trim() ?? ''
      if (!raw || !socket) return
      const filename = raw.endsWith(MARKDOWN_EXTENSION) ? raw : `${raw}${MARKDOWN_EXTENSION}`
      if (newFileInput) newFileInput.value = ''
      openFile(filename)
    }

    if (isBrowser) {
      const authMode = handle.props.authMode
      user = authMode.mode === 'discord' ? authMode.identity : getUser()
      socket = new SocketHandler({
        onFileListUpdate: (next) => {
          files = next
          refresh()
        },
        onSubdocUpdate: (filename) => {
          if (filename === currentFilename) mountEditorIfReady(filename)
        },
        onAwarenessUpdate: () => {
          if (socket) awarenessStates = socket.getAllAwarenessStates()
          refresh()
        },
        onSubdocAwarenessUpdate: (filename) => {
          if (filename === currentFilename) mountEditorIfReady(filename)
          refresh()
        },
      })
      socket.setUser(user)
      awarenessStates = socket.getAllAwarenessStates()

      handle.signal.addEventListener('abort', () => {
        editor?.destroy()
        socket?.close()
      })
    }

    return () => (
      <div mix={layoutStyle}>
        <header mix={headerStyle}>
          <h1 mix={titleStyle}>marky</h1>
          {user && (
            <span mix={userBadgeStyle} style={{ color: user.color }}>
              {user.name}
            </span>
          )}
          {handle.props.authMode.mode === 'discord' && (
            <form method="post" action="/auth/sign-out" mix={signOutFormStyle}>
              <button type="submit" mix={signOutButtonStyle}>
                Sign out
              </button>
            </form>
          )}
        </header>

        <div mix={bodyStyle}>
          <aside mix={sidebarStyle}>
            <div mix={newFileFieldStyle}>
              <input
                type="text"
                placeholder="new-file-name"
                mix={[
                  inputStyle,
                  ref<HTMLInputElement>((node) => {
                    newFileInput = node
                  }),
                  on('keydown', (event) => {
                    if ((event as KeyboardEvent).key === 'Enter') createFile()
                  }),
                ]}
              />
              <button type="button" mix={[buttonStyle, on('click', createFile)]}>
                New
              </button>
            </div>
            <ul mix={fileListStyle}>
              {files.map((file) => {
                const display = file.replace(/\.md$/, '')
                const viewers = collectViewers(awarenessStates, file)
                const active = file === currentFilename
                return (
                  <li
                    key={file}
                    mix={[fileItemStyle, on('click', () => openFile(file))]}
                    style={{
                      background: active ? 'var(--ui-2)' : undefined,
                      fontWeight: active ? 700 : undefined,
                    }}
                  >
                    <span>{display}</span>
                    {viewers.length > 0 && (
                      <span mix={dotsStyle}>
                        {viewers.map((viewer, idx) => (
                          <span
                            key={idx}
                            mix={dotStyle}
                            style={{ background: viewer.color }}
                            title={viewer.name}
                          />
                        ))}
                      </span>
                    )}
                  </li>
                )
              })}
              {files.length === 0 && <li mix={emptyHintStyle}>No files yet — create one above.</li>}
            </ul>
          </aside>

          <section mix={mainStyle}>
            {currentFilename ? (
              <div mix={mainHeaderStyle}>
                <span>{currentFilename.replace(/\.md$/, '')}</span>
                <span mix={editorPresenceStyle}>
                  {socket
                    ? collectSubdocViewers(socket.getSubdocAwarenessStates(currentFilename)).map(
                        (viewer, idx) => (
                          <span
                            key={idx}
                            mix={dotStyle}
                            style={{ background: viewer.color }}
                            title={viewer.name}
                          />
                        ),
                      )
                    : null}
                </span>
              </div>
            ) : (
              <div mix={mainHeaderStyle}>
                <span style={{ color: 'var(--tx-2)' }}>Open a file to start editing.</span>
              </div>
            )}
            <div
              data-testid="editor-mount"
              mix={[
                editorMountStyle,
                ref<HTMLDivElement>((node) => {
                  editorElement = node
                  if (currentFilename) {
                    if (editor) editor.mount(node)
                    else mountEditorIfReady(currentFilename)
                  }
                }),
              ]}
            />
          </section>
        </div>
      </div>
    )
  },
)

function collectViewers(
  states: Map<number, AwarenessClientState>,
  filename: string,
): User[] {
  const out: User[] = []
  for (const state of states.values()) {
    if (state.currentFile === filename && state.user) out.push(state.user)
  }
  return out
}

function collectSubdocViewers(states: Map<number, AwarenessClientState>): User[] {
  const out: User[] = []
  for (const state of states.values()) {
    if (state.user) out.push(state.user)
  }
  return out
}

const layoutStyle = css({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
})

const headerStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 16px',
  borderBottom: '1px solid var(--ui)',
  background: 'var(--bg-2)',
})

const titleStyle = css({
  margin: 0,
  fontSize: '14px',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
})

const userBadgeStyle = css({
  marginLeft: 'auto',
  fontSize: '12px',
  fontWeight: 700,
})

const signOutFormStyle = css({
  margin: 0,
})

const signOutButtonStyle = css({
  font: 'inherit',
  background: 'transparent',
  border: '1px solid var(--ui-2)',
  color: 'var(--tx-2)',
  padding: '4px 10px',
  borderRadius: '4px',
  cursor: 'pointer',
  '&:hover': { color: 'var(--tx)', borderColor: 'var(--tx-3)' },
})

const bodyStyle = css({
  flex: 1,
  display: 'flex',
  minHeight: 0,
})

const sidebarStyle = css({
  width: '260px',
  borderRight: '1px solid var(--ui)',
  background: 'var(--bg-2)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
})

const newFileFieldStyle = css({
  display: 'flex',
  gap: '8px',
  padding: '12px',
  borderBottom: '1px solid var(--ui)',
})

const inputStyle = css({
  flex: 1,
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: '4px',
  border: '1px solid var(--ui-2)',
  background: 'var(--bg)',
  color: 'var(--tx)',
  font: 'inherit',
  '&:focus': { outline: '1px solid var(--tx-2)', outlineOffset: '0' },
})

const buttonStyle = css({
  padding: '6px 12px',
  borderRadius: '4px',
  border: '1px solid var(--ui-2)',
  background: 'var(--bg)',
  color: 'var(--tx)',
  font: 'inherit',
  cursor: 'pointer',
  '&:hover': { background: 'var(--ui)' },
})

const fileListStyle = css({
  margin: 0,
  padding: '8px 0',
  listStyle: 'none',
  overflowY: 'auto',
  flex: 1,
})

const fileItemStyle = css({
  padding: '6px 16px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  '&:hover': { background: 'var(--ui)' },
})

const emptyHintStyle = css({
  padding: '12px 16px',
  color: 'var(--tx-2)',
  fontStyle: 'italic',
})

const dotsStyle = css({
  display: 'inline-flex',
  gap: '4px',
})

const dotStyle = css({
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  display: 'inline-block',
})

const mainStyle = css({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
})

const mainHeaderStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 16px',
  borderBottom: '1px solid var(--ui)',
  background: 'var(--bg-2)',
  '& > span:first-of-type': {
    fontWeight: 700,
  },
  '& > button': {
    marginLeft: 'auto',
  },
})

const editorPresenceStyle = css({
  display: 'inline-flex',
  gap: '4px',
})

const editorMountStyle = css({
  flex: 1,
  overflow: 'auto',
  padding: '16px 24px',
  background: 'var(--bg)',
})
