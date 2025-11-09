import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  ySyncPlugin,
  yUndoPlugin,
  yCursorPlugin,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { PROSEMIRROR_FRAGMENT_NAME } from "../shared/constants";
import { plainTextSchema } from "../shared/doc-utils";

export interface CollaborativeEditorOptions {
  subdoc: Y.Doc;
  awareness: Awareness;
}

export class CollaborativeEditor {
  private subdoc: Y.Doc;
  private type: Y.XmlFragment;
  private awareness: Awareness;
  private editorState: EditorState;
  private view: EditorView | null = null;

  constructor(options: CollaborativeEditorOptions) {
    this.subdoc = options.subdoc;
    this.awareness = options.awareness;

    this.type = this.subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);

    const docFromFragment = yXmlFragmentToProseMirrorRootNode(
      this.type,
      plainTextSchema
    );

    this.editorState = EditorState.create({
      schema: plainTextSchema,
      doc: docFromFragment,
      plugins: [
        ySyncPlugin(this.type),
        yUndoPlugin(),
        yCursorPlugin(this.awareness),
        keymap(baseKeymap),
      ],
    });
  }

  switchToSubdoc(subdoc: Y.Doc, awareness?: Awareness) {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }

    this.subdoc = subdoc;
    this.type = this.subdoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);

    if (awareness) {
      this.awareness = awareness;
    }

    const docFromFragment = yXmlFragmentToProseMirrorRootNode(
      this.type,
      plainTextSchema
    );

    this.editorState = EditorState.create({
      schema: plainTextSchema,
      doc: docFromFragment,
      plugins: [
        ySyncPlugin(this.type),
        yUndoPlugin(),
        yCursorPlugin(this.awareness),
        keymap(baseKeymap),
      ],
    });
  }

  mount(element: HTMLElement) {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }

    element.innerHTML = "";
    this.view = new EditorView(element, {
      state: this.editorState,
      dispatchTransaction: (transaction) => {
        if (this.view) {
          const newState = this.view.state.apply(transaction);
          this.view.updateState(newState);
        }
      },
    });
  }

  destroy() {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
  }

  getState(): EditorState {
    return this.editorState;
  }
}
