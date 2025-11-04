"use server";

import { promises as fs } from "fs";
import { join } from "path";

const CONTENT_DIR = join(process.cwd(), "content");

export async function listFiles(): Promise<string[]> {
  try {
    const files = await fs.readdir(CONTENT_DIR);
    return files.filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    console.error("Error listing files:", error);
    return [];
  }
}

export async function readFile(filename: string): Promise<string> {
  try {
    const filePath = join(CONTENT_DIR, filename);
    const content = await fs.readFile(filePath, "utf-8");
    return content;
  } catch (error) {
    console.error("Error reading file:", error);
    throw new Error(`Failed to read file: ${filename}`);
  }
}

export async function saveFile(
  filename: string,
  content: string
): Promise<void> {
  try {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._\s-]/g, "");
    if (!sanitizedFilename.endsWith(".md")) {
      throw new Error("Filename must end with .md");
    }

    const filePath = join(CONTENT_DIR, sanitizedFilename);
    await fs.writeFile(filePath, content, "utf-8");
  } catch (error) {
    console.error("Error saving file:", error);
    throw new Error(`Failed to save file: ${filename}`);
  }
}

export async function createFile(filename: string): Promise<void> {
  try {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._\s-]/g, "");
    if (!sanitizedFilename.endsWith(".md")) {
      throw new Error("Filename must end with .md");
    }

    const filePath = join(CONTENT_DIR, sanitizedFilename);
    try {
      await fs.access(filePath);
      throw new Error(`File ${sanitizedFilename} already exists`);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        await fs.writeFile(filePath, "", "utf-8");
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error("Error creating file:", error);
    throw error;
  }
}
