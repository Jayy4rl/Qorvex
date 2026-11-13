/**
 * Live events (GET /api/events, server-sent events). Signed-in users get their
 * workspace's events through the session cookie; the single-tenant operator
 * token goes in ?token= because EventSource cannot send headers.
 */
import { useEffect, useRef } from "react";
import type { LiveEvent } from "@qorvex/shared";
import { getToken } from "./session";

export function useLiveEvents(onEvent: (e: LiveEvent) => void, enabled = true): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const token = getToken();
    const es = new EventSource(token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events", { withCredentials: true });
    es.onmessage = (m) => {
      try {
        cb.current(JSON.parse(m.data) as LiveEvent);
      } catch {
        /* ignore malformed events */
      }
    };
    return () => es.close();
  }, [enabled]);
}

/** Call `fn` at most once per `ms` while events keep arriving (refetch on bursts of blocks). */
export function useThrottled(fn: () => void, ms: number): () => void {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return () => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      f.current();
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        f.current();
      }, wait);
    }
  };
}
