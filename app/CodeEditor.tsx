"use client";

import { useAwareness, useText } from "@y-sweet/react";
import { useEffect, useRef, useImperativeHandle } from "react";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab } from "y-codemirror.next";

import "./caret.css";

export interface CodeEditorRef {
  getContent: () => string;
  setContent: (content: string) => void;
  isReady: () => boolean;
}

export interface CodeEditorProps {
  ref?: React.Ref<CodeEditorRef>;
  onReady?: () => void;
}

export const CodeEditor = ({ ref, onReady }: CodeEditorProps) => {
  const yText = useText("text", { observe: "none" });
  const awareness = useAwareness();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    console.log("awareness", awareness);
  }, [awareness]);

  useImperativeHandle(ref, () => ({
    getContent: () => {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    setContent: (content: string) => {
      if (viewRef.current && yText) {
        const transaction = viewRef.current.state.update({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: content,
          },
        });
        viewRef.current.dispatch(transaction);
        yText.delete(0, yText.length);
        yText.insert(0, content);
      }
    },
    isReady: () => {
      return viewRef.current !== null;
    },
  }));

  useEffect(() => {
    if (!editorRef.current || !yText) return;

    if (viewRef.current !== null) {
      return;
    }

    const state = EditorState.create({
      doc: yText.toString(),
      extensions: [
        lineNumbers(),
        markdown(),
        keymap.of(defaultKeymap),
        yCollab(yText, awareness),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    if (onReady) {
      onReady();
    }

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [awareness, yText, onReady]);

  return <div ref={editorRef} className="cm-editor" />;
};
