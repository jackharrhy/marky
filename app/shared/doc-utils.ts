import { plainTextSchema } from "../frontend/schema.js";

// Helper to convert plain text string to ProseMirror doc
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

// Helper to convert ProseMirror doc to plain text string
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
