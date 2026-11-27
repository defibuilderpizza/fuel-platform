"use client";

import { useSyncExternalStore } from "react";

// Studio draft: one prompt shared by every tab, so it follows you when you switch tabs (tabs unmount) and a
// reload, for this browser tab only (sessionStorage). Cleared when the session ends.
const PREFIX = "fuel.studio.draft.";
const subs = new Set<() => void>();
const read = (id: string) => {
  try {
    return sessionStorage.getItem(PREFIX + id);
  } catch {
    return null;
  }
};

/** [draft or null, setDraft]. Null means "nothing typed yet". */
export function useDraft(id: string): [string | null, (v: string) => void] {
  const value = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => read(id),
    () => null,
  );
  const set = (v: string) => {
    try {
      sessionStorage.setItem(PREFIX + id, v);
    } catch {}
    subs.forEach((f) => f());
  };
  return [value, set];
}
