# Code Review: marky Project

## Major Issues

### 1. Code Duplication

**Problem**: `docToText` and `textToDoc` functions are duplicated in:

- `app/assets/entry.tsx` (lines 11-19)
- `app/sockets.ts` (lines 19-47)

**Recommendation**: Extract to `app/frontend/utils.ts` or create `app/frontend/doc-utils.ts`

### 2. Excessive Debug Logging

**Problem**: `entry.tsx` has 20+ `console.log` statements throughout the code

**Recommendation**:

- Remove production logs
- Use a debug utility: `const debug = process.env.NODE_ENV === 'development' ? console.log : () => {}`

### 3. Message Type Constants Duplication

**Problem**: Message type constants defined in:

- `app/sockets.ts` (lines 67-73)
- `app/frontend/SocketHandler.ts` (lines 8-14)

**Recommendation**: Create `app/frontend/message-types.ts` and import in both files

### 4. Complex State Management

**Problem**: `entry.tsx` has 11+ mutable variables managed manually:

- `socketHandler`, `editor`, `currentFilename`, `files`, `editorElement`, `newFileInput`, `editorSetupForFile`, `persistButtonText`, `awarenessStates`, `updateFn`

**Recommendation**:

- Consolidate into a state object
- Or use a simple state management pattern
- Consider using Remix's state management patterns

### 5. SocketHandler Awareness Setup Duplication

**Problem**: Subdoc awareness setup logic duplicated in:

- Constructor `subdocs` handler (lines 106-151)
- `handleWebSocketMessage` for `MESSAGE_TYPE_SUBDOC_SYNC` (lines 269-314)

**Recommendation**: Extract to `setupSubdocAwareness(filename: string, subdoc: Y.Doc)` method

### 6. Complex Editor Lifecycle

**Problem**: Editor setup has multiple conditions and paths:

- `editorSetupForFile` tracking
- Multiple mount points
- Complex conditional logic in `setupEditor`

**Recommendation**:

- Simplify to single source of truth for editor state
- Use a state machine or clearer state flags

### 7. Magic Strings/Numbers

**Problem**: Hardcoded values scattered throughout:

- `"prosemirror"` (multiple files)
- `".md"` (entry.tsx lines 226, 311, 355)
- File paths

**Recommendation**: Extract to constants:

```typescript
const PROSEMIRROR_FRAGMENT_NAME = "prosemirror";
const MARKDOWN_EXTENSION = ".md";
```

### 8. Inconsistent Error Handling

**Problem**:

- Some operations wrapped in try/catch (sockets.ts)
- Others have no error handling (entry.tsx file operations)
- Some errors logged, others silently ignored

**Recommendation**: Standardize error handling pattern

### 9. entry.tsx Doing Too Much

**Problem**: Single file handles:

- Socket connection management
- File list management
- Editor lifecycle
- UI rendering
- Event handlers
- State synchronization

**Recommendation**: Split into:

- `FileManager` component/hook
- `EditorContainer` component
- `SocketProvider` context
- Custom hooks for awareness state

### 10. Type Safety Issues

**Problem**:

- `any` types in SocketHandler (line 154, 239, 317)
- Loose type assertions
- Missing return types

**Recommendation**: Add proper types, avoid `any`

## Minor Issues

### 11. Unused Variables

- `welshFlowers` array in `utils.ts` - only used for random name generation, could be simplified

### 12. Inefficient Awareness State Access

- `getAllAwarenessStates()` creates new Map every call - could cache or optimize

### 13. Server-side File Scanning

- `scanContentDirectory()` called on every subdoc event - could be debounced or optimized

### 14. Missing Cleanup

- No cleanup for awareness listeners when files are closed
- Editor view cleanup could be more thorough

### 15. Hardcoded Timeout

- `setTimeout` with magic number `5000` in `handlePersist` - extract to constant

## Simplification Opportunities

1. **Remove `editorSetupForFile` tracking** - use `currentFilename` comparison instead
2. **Simplify awareness state** - combine root and subdoc awareness into single structure
3. **Extract file operations** - create `FileOperations` utility class
4. **Simplify message protocol** - use JSON for non-binary messages instead of manual buffer construction
5. **Use async/await consistently** - some callbacks could be async functions

## Code Smells

1. **Long functions**: `handleWebSocketMessage` in SocketHandler (140+ lines)
2. **Deep nesting**: Multiple levels of conditionals in entry.tsx
3. **Tight coupling**: entry.tsx directly manipulates DOM elements
4. **Side effects in render**: State updates happening during render phase

## Positive Aspects

✅ Good separation of concerns between frontend/backend
✅ Proper use of Yjs for CRDT
✅ Clean CollaborativeEditor abstraction
✅ Good use of TypeScript overall
✅ Proper WebSocket upgrade handling

## Priority Fixes

1. **High**: Extract duplicated `docToText`/`textToDoc` functions
2. **High**: Remove excessive console.logs
3. **Medium**: Extract message type constants
4. **Medium**: Simplify editor lifecycle
5. **Medium**: Extract awareness setup duplication
6. **Low**: Extract magic strings/numbers
7. **Low**: Improve type safety
