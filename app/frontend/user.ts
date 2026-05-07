// Identity for the current browser tab. Persisted in localStorage so awareness
// stays stable across reloads. We pick a random Welsh-flower name and a hex
// color from a small fixed palette.

const FLOWERS = [
  'Daffodil',
  'Leek',
  'Bluebell',
  'Primrose',
  'Foxglove',
  'Buttercup',
  'Clover',
  'Heather',
  'Gorse',
  'Hawthorn',
  'Blackthorn',
  'Violet',
  'Snowdrop',
  'Poppy',
  'Thistle',
  'Lily',
  'Dandelion',
  'Honeysuckle',
  'Fern',
  'Cornflower',
] as const

export const PALETTE_COLORS = [
  '#205ea6', // blue
  '#24837b', // cyan
  '#66800b', // green
  '#ad8301', // yellow
  '#bc5215', // orange
  '#af3029', // red
  '#5e409d', // purple
  '#a02f6f', // magenta
] as const

const STORAGE_KEY = 'marky:user'

export interface User {
  name: string
  color: string
}

export function getUser(): User {
  const stored = readStored()
  if (stored) return stored
  const created: User = {
    name: `Anonymous ${pick(FLOWERS)}`,
    color: pick(PALETTE_COLORS),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(created))
  } catch {
    // Private mode etc. — fine, user is ephemeral.
  }
  return created
}

function readStored(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<User>
    if (typeof parsed.name === 'string' && typeof parsed.color === 'string') {
      return { name: parsed.name, color: parsed.color }
    }
  } catch {
    // Ignore parse failures and re-roll.
  }
  return null
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)]
}
