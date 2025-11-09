import * as Y from "yjs";
import { CollaborativeEditor } from "./CollaborativeEditor";
import { SocketHandler } from "./SocketHandler";
import { PROSEMIRROR_FRAGMENT_NAME } from "../shared/constants";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { plainTextSchema } from "../shared/doc-utils";
import { docToText } from "../shared/doc-utils";
import debugFactory from "debug";

const debug = debugFactory("marky:frontend:EditorManager");

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
    this.editorElement = element;
    if (this.editor && element) {
      this.editor.mount(element);
    } else if (this.currentFilename) {
      const subdoc = this.socketHandler.getSubdoc(this.currentFilename);
      if (subdoc) {
        this.setupEditor(subdoc, this.currentFilename);
      }
    }
  }

  setCurrentFilename(filename: string | null) {
    this.currentFilename = filename;
    this.editorSetupForFile = null;
  }

  handleSubdocUpdate(filename: string, subdoc: Y.Doc) {
    debug("handleSubdocUpdate called for:", filename);
    if (
      filename === this.currentFilename &&
      this.editorSetupForFile !== filename
    ) {
      this.setupEditor(subdoc, filename);
    }
  }

  persist() {
    if (!this.currentFilename || !this.socketHandler) {
      return;
    }

    this.socketHandler.persistFile(this.currentFilename);

    return true;
  }

  getEditor(): CollaborativeEditor | null {
    return this.editor;
  }

  private setupEditor(subdoc: Y.Doc, filename: string) {
    if (!this.socketHandler) return;

    if (this.editorSetupForFile === filename && this.editor) {
      return;
    }

    let subdocAwareness = this.socketHandler.getSubdocAwareness(filename);
    if (!subdocAwareness) {
      console.warn(
        "Subdoc awareness not yet available, will be created on subdoc load"
      );
      return;
    }

    if (this.editor) {
      this.editor.switchToSubdoc(subdoc, subdocAwareness);
    } else {
      this.editor = new CollaborativeEditor({
        subdoc,
        awareness: subdocAwareness,
      });
    }

    this.editorSetupForFile = filename;

    if (this.editorElement) {
      this.editor.mount(this.editorElement);
    } else {
      console.warn(
        "Editor element not available yet, will mount on element connect"
      );
    }
  }
}
