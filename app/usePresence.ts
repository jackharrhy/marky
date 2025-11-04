"use client";

import { useState, useEffect } from "react";

export interface UserPresence {
  name: string;
  color: string;
  currentFile?: string;
}

const STORAGE_KEY = "marky-user-presence";

function generateDefaultPresence(): UserPresence {
  return {
    name: "Anonymous",
    color: "gray",
  };
}

export function loadPresenceFromStorage(): UserPresence {
  if (typeof window === "undefined") {
    return generateDefaultPresence();
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error("Error loading presence from localStorage:", error);
  }

  const randomPresence = generateDefaultPresence();
  savePresenceToStorage(randomPresence);
  return randomPresence;
}

export function savePresenceToStorage(presence: UserPresence): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presence));
  } catch (error) {
    console.error("Error saving presence to localStorage:", error);
  }
}

export function useLocalPresence() {
  const [presence, setPresence] = useState<UserPresence>(() =>
    loadPresenceFromStorage()
  );

  useEffect(() => {
    setPresence(loadPresenceFromStorage());
  }, []);

  const updatePresence = (updates: Partial<UserPresence>) => {
    const newPresence = { ...presence, ...updates };
    setPresence(newPresence);
    savePresenceToStorage(newPresence);
  };

  return { presence, updatePresence };
}
