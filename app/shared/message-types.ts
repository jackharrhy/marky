// Wire-format message tags. Each binary frame begins with one of these bytes.
export const MESSAGE_TYPE_SYNC = 0
export const MESSAGE_TYPE_AWARENESS = 1
export const MESSAGE_TYPE_FILE_LIST = 2
export const MESSAGE_TYPE_OPEN_FILE = 3
export const MESSAGE_TYPE_PERSIST_FILE = 4
export const MESSAGE_TYPE_SUBDOC_SYNC = 5
export const MESSAGE_TYPE_SUBDOC_AWARENESS = 6

export type MessageType =
  | typeof MESSAGE_TYPE_SYNC
  | typeof MESSAGE_TYPE_AWARENESS
  | typeof MESSAGE_TYPE_FILE_LIST
  | typeof MESSAGE_TYPE_OPEN_FILE
  | typeof MESSAGE_TYPE_PERSIST_FILE
  | typeof MESSAGE_TYPE_SUBDOC_SYNC
  | typeof MESSAGE_TYPE_SUBDOC_AWARENESS
