import * as Y from "yjs";
import { CollaborativeEditor } from "./CollaborativeEditor";
import { SocketHandler } from "./SocketHandler";
import { log } from "../shared/log";
import { PROSEMIRROR_FRAGMENT_NAME } from "../shared/constants";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { plainTextSchema } from "./schema";
import { docToText } from "../shared/doc-utils";

export class EditorManager {
  private socketHandler: SocketHandler;
  private editor: CollaborativeEditor | null = null;
  private editorElement: HTMLElement | null = null;
  private editorSetupForFile: string | null = null;
  private currentFilename: string | null = null;

  constructor(socketHandler: SocketHandler) {
    this.socketHandler = socketHandler;
  }

  setEditorElement(element: HTMLElement | null) {
    log.info("Editor element connected");
    this.editorElement = element;
    if (this.editor) {
      log.info("Mounting existing editor");
      this.editor.mount(element);
    } else if (this.currentFilename) {
      // If we have a file open but no editor yet, set it up
      log.info("Setting up editor for current file:", this.currentFilename);
      const subdoc = this.socketHandler.getSubdoc(this.currentFilename);
      if (subdoc) {
        // setupEditor will mount since editorElement is now set
        this.setupEditor(subdoc, this.currentFilename);
      }
    }
  }

  setCurrentFilename(filename: string | null) {
    this.currentFilename = filename;
    this.editorSetupForFile = null; // Reset so editor will be set up for new file
  }

  handleSubdocUpdate(filename: string, subdoc: Y.Doc) {
    log.info("handleSubdocUpdate called for:", filename);
    // Only set up editor when we receive a subdoc update for the current file
    // and editor isn't already set up for this file
    if (
      filename === this.currentFilename &&
      this.editorSetupForFile !== filename
    ) {
      // Check XmlFragment for content - backend has populated it
      const xmlFragment = subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      const doc = yXmlFragmentToProseMirrorRootNode(
        xmlFragment,
        plainTextSchema
      );
      const text = docToText(doc);

      log.info("Content length:", text.length);

      // If server sent us the subdoc update, content is loaded (even if empty)
      // Empty files are valid - set up the editor
      this.setupEditor(subdoc, filename);
    }
  }

  handleFileOpened(filename: string, subdoc: Y.Doc) {
    // Don't set up editor here - wait for content to arrive via handleSubdocUpdate
    // This callback just indicates the subdoc is available, not that content is loaded
    log.info("File opened (subdoc available):", filename);
  }

  persist() {
    if (!this.currentFilename || !this.socketHandler || !this.editor) {
      return;
    }

    // Get content from editor and convert to text for server
    const state = this.editor.getState();
    const text = docToText(state.doc);

    // Send persist request - server will read from XmlFragment directly
    // (ySyncPlugin has already synced editor changes to XmlFragment)
    this.socketHandler.persistFile(this.currentFilename);

    return true;
  }

  getEditor(): CollaborativeEditor | null {
    return this.editor;
  }

  private setupEditor(subdoc: Y.Doc, filename: string) {
    if (!this.socketHandler) return;

    // Only set up editor if this is a different file or editor isn't set up yet
    if (this.editorSetupForFile === filename && this.editor) {
      return; // Already set up for this file
    }

    // Get subdoc-specific awareness (create if needed)
    let subdocAwareness = this.socketHandler.getSubdocAwareness(filename);
    if (!subdocAwareness) {
      // Awareness will be created when subdoc loads, wait for it
      log.info(
        "Subdoc awareness not yet available, will be created on subdoc load"
      );
      return;
    }

    if (this.editor) {
      // If editor exists, switch to new subdoc and awareness
      log.info("Switching editor to new subdoc");
      this.editor.switchToSubdoc(subdoc, subdocAwareness);
    } else {
      // Create new editor - backend has already populated XmlFragment
      log.info("Creating new editor");
      this.editor = new CollaborativeEditor({
        subdoc,
        awareness: subdocAwareness,
      });
    }

    this.editorSetupForFile = filename; // Track that we've set up for this file

    // Mount editor to element if it exists
    if (this.editorElement) {
      log.info("Mounting editor to element");
      this.editor.mount(this.editorElement);
    } else {
      log.info(
        "Editor element not available yet, will mount on element connect"
      );
    }
  }
}
