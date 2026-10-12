"use client";

import { ApiError, getAccessToken } from "@/lib/api";

/** One Server-Sent Event: `event:` name (defaults to "message") and the joined `data:` payload. */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser. Feed it decoded chunks as they arrive
 * — chunk boundaries may fall anywhere, including mid-line — and it returns the
 * events completed by each chunk. Multi-line `data:` fields are joined with "\n"
 * per the spec; comment lines (":") and unknown fields are ignored.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Flush at end of stream: a final event without a trailing blank line still dispatches. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    const ev = this.dispatch();
    if (ev) out.push(ev);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        this.id = value;
        break;
      default:
        // "retry" and unknown fields are ignored (no reconnect here).
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.data.length === 0 && this.event === "") return null;
    const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) ev.id = this.id;
    this.event = "";
    this.data = [];
    return ev;
  }
}

/** Parse a whole ReadableStream of bytes into SSE events, one at a time. */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.feed(decoder.decode())) yield ev;
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.releaseLock();
  }
}

/** Parse the `data:` payload of an event as JSON; the raw string when it isn't JSON. */
export function parseSseData<T = unknown>(ev: SseEvent): T {
  try {
    return JSON.parse(ev.data) as T;
  } catch {
    return ev.data as unknown as T;
  }
}

/**
 * POST JSON to a backend SSE endpoint with the Supabase JWT (EventSource can't
 * set headers) and invoke `onEvent` for each event. Resolves when the stream
 * ends; rejects with ApiError on a non-2xx status.
 */
export async function streamSse(
  path: string,
  body: unknown,
  onEvent: (ev: SseEvent) => void,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const token = await getAccessToken();
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail: unknown = text;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  if (!res.body) throw new Error("Streaming response had no body");
  for await (const ev of readSseStream(res.body, opts.signal)) onEvent(ev);
}
