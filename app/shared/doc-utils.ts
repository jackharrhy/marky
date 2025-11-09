import { Schema } from "prosemirror-model";

export const plainTextSchema = new Schema({
  nodes: {
    doc: {
      content: "paragraph+",
    },
    paragraph: {
      content: "text*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    text: {},
  },
});

export function textToDoc(
  text: string
): ReturnType<typeof plainTextSchema.node> {
  if (!text) {
    return plainTextSchema.node("doc", null, [
      plainTextSchema.node("paragraph"),
    ]);
  }
  const lines = text.split("\n");
  const paragraphs = lines.map((line) => {
    if (line === "") {
      return plainTextSchema.node("paragraph");
    }
    return plainTextSchema.node("paragraph", null, [
      plainTextSchema.text(line),
    ]);
  });
  return plainTextSchema.node("doc", null, paragraphs);
}

export function docToText(
  doc: ReturnType<typeof plainTextSchema.node>
): string {
  const paragraphs: string[] = [];
  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      paragraphs.push(node.textContent);
    }
  });
  return paragraphs.join("\n");
}
