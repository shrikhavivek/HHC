"use client";
import { useEffect, useRef, useState } from "react";

export function useUndoHistory<T>(value: T, apply: (value: T) => void, enabled: boolean) {
  const history = useRef<string[]>([]);
  const cursor = useRef(0);
  const restoring = useRef(false);
  const latest = useRef(value);
  const applyRef = useRef(apply);
  const [, refresh] = useState(0);
  latest.current = value;
  applyRef.current = apply;
  const serialized = JSON.stringify(value);
  useEffect(() => {
    history.current = enabled ? [serialized] : [];
    cursor.current = 0;
    refresh(n => n + 1);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    if (restoring.current) { restoring.current = false; return; }
    const timer = setTimeout(() => {
      if (history.current[cursor.current] === serialized) return;
      history.current = [...history.current.slice(0, cursor.current + 1), serialized].slice(-60);
      cursor.current = history.current.length - 1;
      refresh(n => n + 1);
    }, 250);
    return () => clearTimeout(timer);
  }, [serialized, enabled]);
  function move(direction: number) {
    // Include a drag's most recent position even if its debounce has not fired.
    const current = JSON.stringify(latest.current);
    if (direction < 0 && history.current[cursor.current] !== current) {
      history.current = [...history.current.slice(0, cursor.current + 1), current].slice(-60);
      cursor.current = history.current.length - 1;
    }
    const next = cursor.current + direction;
    if (next < 0 || next >= history.current.length) return;
    cursor.current = next;
    restoring.current = true;
    applyRef.current(JSON.parse(history.current[next]));
    refresh(n => n + 1);
  }
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    if (!enabled) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input,textarea,[contenteditable=true]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); moveRef.current(event.shiftKey ? 1 : -1); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); moveRef.current(1); }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [enabled]);
  return { undo: () => move(-1), redo: () => move(1), canUndo: cursor.current > 0 || (enabled && history.current[cursor.current] !== serialized), canRedo: cursor.current < history.current.length - 1 };
}
