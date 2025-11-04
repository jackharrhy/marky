"use client";

import { useEffect } from "react";
import { useAwareness, usePresence, usePresenceSetter } from "@y-sweet/react";
import { UserPresence } from "./usePresence";

interface PresenceManagerProps {
  presence: UserPresence;
}

export function PresenceManager({ presence }: PresenceManagerProps) {
  const people = usePresence();
  const setPresence = usePresenceSetter();
  const awareness = useAwareness();

  useEffect(() => {
    setPresence({
      name: presence.name,
      color: presence.color,
    });
    awareness.setLocalStateField("user", {
      name: presence.name,
      color: presence.color,
    });
  }, [presence, setPresence, awareness]);

  const peopleArray = Array.from(people.values());

  return (
    <div className="flex items-center gap-2">
      {peopleArray.map((person, idx) => (
        <div key={person.clientId || idx} className="flex items-center gap-1">
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{
              backgroundColor: person.color || "#aaa",
              border: "1px solid #ccc",
            }}
            title={person.name}
          ></span>
          <span className="text-xs text-gray-600">
            {person.name || "Anonymous"}
          </span>
        </div>
      ))}
    </div>
  );
}
