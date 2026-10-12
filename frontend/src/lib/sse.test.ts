import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getAccessToken: async () => "tok",
  ApiError: class ApiError extends Error {
    status: number;
    detail: unknown;
    constructor(status: number, detail: unknown) {
      super(`${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      this.status = status;
      this.detail = detail;
    }
  },
}));

import { parseSseData, readSseStream, SseParser, streamSse } from "./sse";

function collect(parser: SseParser, chunks: string[]) {
  const out = chunks.flatMap((c) => parser.feed(c));
  return [...out, ...parser.end()];
}

describe("SseParser", () => {
  it("parses a single complete event", () => {
    const evs = collect(new SseParser(), ['event: token\ndata: {"text":"hi"}\n\n']);
    expect(evs).toEqual([{ event: "token", data: '{"text":"hi"}' }]);
  });

  it("reassembles events split across arbitrary chunk boundaries", () => {
    const whole = 'event: token\ndata: {"text":"hel\nlo"}\n\nevent: done\ndata: {}\n\n';
    // Split at every possible offset and make sure the result never changes.
    for (let i = 1; i < whole.length - 1; i++) {
      const evs = collect(new SseParser(), [whole.slice(0, i), whole.slice(i)]);
      expect(evs, `split at ${i}`).toEqual([
        { event: "token", data: '{"text":"hel' },
        { event: "done", data: "{}" },
      ]);
    }
    // ...and one byte at a time.
    const evs = collect(new SseParser(), whole.split(""));
    expect(evs).toHaveLength(2);
  });

  it("joins multi-line data with newlines", () => {
    const evs = collect(new SseParser(), ["event: message\ndata: line one\ndata: line two\ndata:\n\n"]);
    expect(evs).toEqual([{ event: "message", data: "line one\nline two\n" }]);
  });

  it("defaults the event name to message and strips one leading space only", () => {
    const evs = collect(new SseParser(), ["data:  two spaces\n\n"]);
    expect(evs).toEqual([{ event: "message", data: " two spaces" }]);
  });

  it("ignores comments, ids are carried, CRLF is accepted", () => {
    const evs = collect(new SseParser(), [": keep-alive\r\nid: 7\r\nevent: plan\r\ndata: {\"v\":1}\r\n\r\n"]);
    expect(evs).toEqual([{ event: "plan", data: '{"v":1}', id: "7" }]);
  });

  it("dispatches a trailing event with no final blank line on end()", () => {
    const p = new SseParser();
    expect(p.feed("event: done\ndata: {}")).toEqual([]);
    expect(p.end()).toEqual([{ event: "done", data: "{}" }]);
  });

  it("does not emit empty events for stray blank lines", () => {
    expect(collect(new SseParser(), ["\n\n\n"])).toEqual([]);
  });
});

describe("parseSseData", () => {
  it("parses JSON and falls back to the raw string", () => {
    expect(parseSseData({ event: "x", data: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseSseData({ event: "x", data: "not json" })).toBe("not json");
  });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("readSseStream", () => {
  it("yields events from a byte stream, including a multi-byte char split across chunks", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode("event: token\ndata: héllo\n\n");
    const cut = 15; // inside the "é" (2 bytes) — the decoder must carry state across reads
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out = [];
    for await (const ev of readSseStream(stream)) out.push(ev);
    expect(out).toEqual([{ event: "token", data: "héllo" }]);
  });
});

describe("streamSse", () => {
  it("POSTs JSON with the bearer token and dispatches each event", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect((init?.headers as Record<string, string>).Accept).toBe("text/event-stream");
      expect(init?.body).toBe(JSON.stringify({ content: "hi" }));
      return new Response(streamOf(["event: token\ndata: {\"text\":\"a\"}\n\n", "event: done\ndata: {}\n\n"]), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    await streamSse("/api/builds/1/messages", { content: "hi" }, (ev) => seen.push(ev.event), { fetchImpl });
    expect(seen).toEqual(["token", "done"]);
  });

  it("rejects with the status and parsed detail on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "nope" }), { status: 403 })) as unknown as typeof fetch;
    await expect(streamSse("/api/builds/1/messages", {}, () => {}, { fetchImpl })).rejects.toMatchObject({
      status: 403,
      detail: "nope",
    });
  });
});
