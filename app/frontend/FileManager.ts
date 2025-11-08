import { SocketHandler } from "./SocketHandler";
import { log } from "../shared/log";
import { MARKDOWN_EXTENSION } from "../shared/constants";

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
    log.info(
      `handleFileListUpdate called with file list of ${fileList.length} files`
    );
    this.files = fileList;
    this.onFilesChange?.();
  }

  openFile(filename: string) {
    log.info("openFile called with:", filename);
    log.info("Setting currentFilename to:", filename);
    this.currentFilename = filename;

    // Update awareness state with current file
    this.socketHandler.setCurrentFile(filename);

    this.onCurrentFileChange?.();

    // Request to open file - editor will be set up when content arrives
    log.info("Calling socketHandler.openFile");
    this.socketHandler.openFile(filename);
  }

  createNewFile(filename: string) {
    const trimmed = filename.trim();
    if (!trimmed) {
      log.info("Early return: empty filename");
      return;
    }

    const fullFilename = trimmed.endsWith(MARKDOWN_EXTENSION)
      ? trimmed
      : `${trimmed}${MARKDOWN_EXTENSION}`;
    log.info("Opening file:", fullFilename);

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
