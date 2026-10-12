"use client";

import { useEffect, useState } from "react";

const moods = [
  { id: "lilac", name: "Lilac muse" },
  { id: "rose", name: "Rose editorial" },
  { id: "mint", name: "Mint atelier" },
] as const;

export function StudioMood() {
  const [mood, setMood] = useState("lilac");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("hhc-studio-mood");
      if (moods.some(item => item.id === saved)) {
        setMood(saved!);
        document.documentElement.dataset.studioMood = saved!;
      }
    } catch { /* The palette still works when browser storage is unavailable. */ }
  }, []);

  function choose(value: string) {
    setMood(value);
    document.documentElement.dataset.studioMood = value;
    try { localStorage.setItem("hhc-studio-mood", value); } catch { /* Optional preference. */ }
  }

  return <div className="studio-mood" role="group" aria-label="Studio colour palette">
    <span>Set the mood</span>
    {moods.map(item => <button key={item.id} type="button" className={`mood-swatch mood-${item.id}`}
      aria-label={item.name} title={item.name} aria-pressed={mood === item.id} onClick={() => choose(item.id)}>
      <span aria-hidden="true">{mood === item.id ? "✓" : ""}</span>
    </button>)}
  </div>;
}
