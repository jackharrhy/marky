import { SocketHandler } from "./SocketHandler";
import { MARKDOWN_EXTENSION } from "../shared/constants";

import debugFactory from "debug";
const debug = debugFactory("marky:frontend:FileManager");

export class FileManager {
  private socketHandler: SocketHandler;
  private files: string[] = [];
  private currentFilename: string | null = null;
  private onFilesChange?: () => void;
  private onCurrentFileChange?: () => void;

  constructor(
    socketHandler: SocketHandler,
    onFilesChange?: () => void,
    onCurrentFileChange?: () => void
  ) {
    this.socketHandler = socketHandler;
    this.onFilesChange = onFilesChange;
    this.onCurrentFileChange = onCurrentFileChange;
  }

  handleFileListUpdate(fileList: string[]) {
    debug(
      `handleFileListUpdate called with file list of ${fileList.length} files`
    );
    this.files = fileList;
    this.onFilesChange?.();
  }

  openFile(filename: string) {
    debug("openFile called with:", filename);
    this.currentFilename = filename;
    this.socketHandler.setCurrentFile(filename);
    this.onCurrentFileChange?.();
    this.socketHandler.openFile(filename);
  }

  createNewFile(filename: string) {
    const trimmed = filename.trim();
    if (!trimmed) {
      console.warn("cannot create new file with empty filename");
      return;
    }

    const fullFilename = trimmed.endsWith(MARKDOWN_EXTENSION)
      ? trimmed
      : `${trimmed}${MARKDOWN_EXTENSION}`;

    this.openFile(fullFilename);
  }

  getFiles(): string[] {
    return this.files;
  }

  getCurrentFilename(): string | null {
    return this.currentFilename;
  }

  setCurrentFilename(filename: string | null) {
    this.currentFilename = filename;
    this.onCurrentFileChange?.();
  }
}
