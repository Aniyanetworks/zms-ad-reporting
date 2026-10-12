"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bot, CheckCircle2, FileText, Loader2, Send, Sparkles, Wrench, XCircle } from "lucide-react";
import { messagesKey, useSetBuild } from "@/components/build/use-build";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch, type Build, type ChatMessage, type Plan, type Validation } from "@/lib/api";
import { parseSseData, streamSse, type SseEvent } from "@/lib/sse";
import { cn } from "@/lib/utils";

interface ToolChip {
  name: string;
  status: "start" | "ok" | "error";
  detail?: string;
}

interface StreamState {
  text: string;
  thinking: string[];
  tools: ToolChip[];
  error: string | null;
}

const TOOL_LABELS: Record<string, string> = {
  search_locations: "Searching locations",
  geo_search: "Searching locations",
  propose_plan: "Proposing plan",
  update_plan: "Updating plan",
  validate_plan: "Validating plan",
  read_account: "Reading account",
  read_brief: "Reading brief",
  update_brief: "Updating brief",
  list_assets: "Checking creatives",
};

function toolLabel(name: string, status: ToolChip["status"], detail?: string): string {
  const base = TOOL_LABELS[name] ?? name.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  if (detail) return status === "start" ? `${detail}…` : detail;
  if (status === "start") return `${base}…`;
  if (status === "error") return `${base} failed`;
  // Finished chips read in the past tense: "Proposing plan" → "Proposed plan".
  return base
    .replace(/^Searching/, "Searched")
    .replace(/^Proposing/, "Proposed")
    .replace(/^Updating/, "Updated")
    .replace(/^Validating/, "Validated")
    .replace(/^Reading/, "Read")
    .replace(/^Checking/, "Checked");
}

function ToolChipView({ chip }: { chip: ToolChip }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        chip.status === "error" ? "border-red-500/40 text-red-400" : "text-muted-foreground",
      )}
    >
      {chip.status === "start" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : chip.status === "error" ? (
        <XCircle className="h-3 w-3" />
      ) : (
        <Wrench className="h-3 w-3" />
      )}
      {toolLabel(chip.name, chip.status, chip.detail)}
    </span>
  );
}

function PlanMarker({ version }: { version: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-400">
      <FileText className="h-3 w-3" /> Plan v{version}
    </span>
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  if (m.role === "tool") {
    return (
      <div className="flex flex-wrap items-center gap-1.5 pl-8">
        <ToolChipView chip={{ name: m.tool_name ?? "tool", status: m.tool_status === "error" ? "error" : "ok", detail: m.text ?? undefined }} />
        {m.plan_version !== undefined && <PlanMarker version={m.plan_version} />}
      </div>
    );
  }
  const user = m.role === "user";
  return (
    <div className={cn("flex gap-2", user ? "justify-end" : "justify-start")}>
      {!user && (
        <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Bot className="h-3.5 w-3.5" />
        </span>
      )}
      <div className={cn("max-w-[85%] space-y-1", user && "items-end")}>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
            user ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted",
          )}
        >
          {m.text}
        </div>
        <div className={cn("flex items-center gap-2 text-[10px] text-muted-foreground", user && "justify-end")}>
          {m.plan_version !== undefined && !user && <PlanMarker version={m.plan_version} />}
          <span>{new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Draft a plan",
  "Use two ad sets: broad and retargeting",
  "Tighten the geo to a 20-mile radius",
  "Rewrite the headlines to lead with the offer",
];

export function ChatPanel({ build, canEdit }: { build: Build; canEdit: boolean }) {
  const qc = useQueryClient();
  const setBuild = useSetBuild(build.id);
  const [draft, setDraft] = useState("");
  const [stream, setStream] = useState<StreamState | null>(null);
  const [optimistic, setOptimistic] = useState<ChatMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messages = useQuery({
    queryKey: messagesKey(build.id),
    queryFn: () => apiFetch<ChatMessage[]>(`/api/builds/${encodeURIComponent(build.id)}/messages`),
  });

  const list = messages.data ?? [];
  const streaming = stream !== null;
  const scrollKey = `${list.length}:${stream?.text.length ?? -1}:${stream?.tools.length ?? 0}:${optimistic?.id ?? ""}`;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [scrollKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function onEvent(ev: SseEvent) {
    switch (ev.event) {
      case "token": {
        const { text } = parseSseData<{ text: string }>(ev);
        setStream((s) => (s ? { ...s, text: s.text + (text ?? "") } : s));
        break;
      }
      case "thinking": {
        const { text } = parseSseData<{ text: string }>(ev);
        if (text) setStream((s) => (s ? { ...s, thinking: [...s.thinking, text] } : s));
        break;
      }
      case "tool": {
        const t = parseSseData<{ name: string; status: ToolChip["status"]; detail?: string }>(ev);
        setStream((s) => {
          if (!s) return s;
          const tools = [...s.tools];
          // Update the most recent open chip for this tool, otherwise append.
          const i = tools.map((c) => c.name === t.name && c.status === "start").lastIndexOf(true);
          if (i >= 0 && t.status !== "start") tools[i] = { ...tools[i], status: t.status, detail: t.detail ?? tools[i].detail };
          else tools.push({ name: t.name, status: t.status, detail: t.detail });
          return { ...s, tools };
        });
        break;
      }
      case "plan": {
        const p = parseSseData<{ plan: Plan; plan_version: number; validation: Validation | null }>(ev);
        setBuild((b) => ({ ...b, plan: p.plan, plan_version: p.plan_version, validation: p.validation ?? b.validation }));
        break;
      }
      case "message": {
        const m = parseSseData<ChatMessage>(ev);
        if (m && m.role === "assistant") {
          qc.setQueryData<ChatMessage[]>(messagesKey(build.id), (prev) =>
            prev && !prev.some((x) => x.id === m.id) ? [...prev, { ...m, created_at: m.created_at ?? new Date().toISOString() }] : prev,
          );
          setStream((s) => (s ? { ...s, text: "" } : s));
        }
        break;
      }
      case "error": {
        const { message } = parseSseData<{ message: string }>(ev);
        setStream((s) => (s ? { ...s, error: message ?? "The assistant hit an error." } : s));
        break;
      }
      case "done": {
        const { build: fresh } = parseSseData<{ build: Build }>(ev);
        if (fresh) setBuild(fresh);
        break;
      }
      default:
        break;
    }
  }

  async function send() {
    const content = draft.trim();
    if (!content || streaming || !canEdit) return;
    setDraft("");
    const now = new Date().toISOString();
    setOptimistic({ id: `local-${Date.now()}`, role: "user", text: content, created_at: now });
    setStream({ text: "", thinking: [], tools: [], error: null });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamSse(`/api/builds/${encodeURIComponent(build.id)}/messages`, { content }, onEvent, { signal: ac.signal });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setStream((s) => ({ ...(s ?? { text: "", thinking: [], tools: [] }), error: (err as Error).message.replace(/^\d{3}:\s*/, "") }));
      }
    } finally {
      abortRef.current = null;
      // Persisted messages (user, tool and assistant rows) replace the transient state.
      await qc.invalidateQueries({ queryKey: messagesKey(build.id) });
      qc.invalidateQueries({ queryKey: ["build", build.id] });
      setOptimistic(null);
      setStream((s) => (s?.error ? { text: "", thinking: [], tools: [], error: s.error } : null));
      textareaRef.current?.focus();
    }
  }

  const ctx = build.account_context;
  // After the stream ends with an error and nothing else to show, render the error alone (no empty bubble).
  const showError = !!stream?.error && stream.text === "" && stream.tools.length === 0 && stream.thinking.length === 0;

  return (
    <>
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Chat</h2>
          {build.plan_version > 0 && <PlanMarker version={build.plan_version} />}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={ctx ? `${ctx.ad_account_id} · ${ctx.timezone}` : undefined}>
          {ctx ? (
            <>
              <span className="font-mono">{ctx.ad_account_id}</span> · {ctx.currency} · Page {ctx.page_name ?? ctx.page_id}
              {ctx.page_name && <span className="font-mono"> ({ctx.page_id})</span>} · {ctx.lead_forms.length} lead form
              {ctx.lead_forms.length === 1 ? "" : "s"} · {ctx.existing_campaign_names.length} existing campaign
              {ctx.existing_campaign_names.length === 1 ? "" : "s"}
            </>
          ) : (
            "Account context not loaded yet — it is read from Meta when the build is created."
          )}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading conversation…</p>
        ) : list.length === 0 && !optimistic && !stream ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Sparkles className="h-6 w-6 text-primary" />
            <p className="max-w-sm text-sm text-muted-foreground">
              Tell me about the offer, budget, and where you want to run — or just say{" "}
              <span className="text-foreground">&ldquo;draft a plan&rdquo;</span> and I&rsquo;ll work from the brief.
            </p>
            {canEdit && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDraft(s)}
                    className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {list.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
            {optimistic && <MessageBubble m={optimistic} />}
            {stream && (stream.text || stream.thinking.length > 0 || stream.tools.length > 0 || !stream.error) && !showError && (
              <div className="flex gap-2">
                <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <div className="max-w-[85%] space-y-1.5">
                  {stream.thinking.map((t, i) => (
                    <p key={i} className="text-xs italic text-muted-foreground">
                      {t}
                    </p>
                  ))}
                  {stream.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {stream.tools.map((c, i) => (
                        <ToolChipView key={`${c.name}-${i}`} chip={c} />
                      ))}
                    </div>
                  )}
                  {(stream.text || (stream.tools.length === 0 && stream.thinking.length === 0)) && (
                    <div className="rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
                      {stream.text}
                      {!stream.error && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/60 align-middle" />}
                    </div>
                  )}
                  {stream.error && (
                    <p className="flex items-center gap-1 text-xs text-red-400" role="alert">
                      <AlertCircle className="h-3 w-3" /> {stream.error}
                    </p>
                  )}
                </div>
              </div>
            )}
            {showError && (
              <p className="flex items-center gap-1 pl-8 text-xs text-red-400" role="alert">
                <AlertCircle className="h-3 w-3" /> {stream?.error}
              </p>
            )}
          </>
        )}
        {messages.error && (
          <p className="text-xs text-red-400" role="alert">
            {(messages.error as Error).message}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="border-t p-3">
        {canEdit ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              ref={textareaRef}
              value={draft}
              disabled={streaming}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={streaming ? "Thinking…" : "Message the builder — Enter to send, Shift+Enter for a new line"}
              rows={2}
              className="max-h-40 min-h-10 resize-none"
              aria-label="Message"
            />
            <Button type="submit" size="icon" disabled={streaming || !draft.trim()} aria-label="Send">
              {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {build.status === "created" || build.status === "creating" || build.status === "approved"
              ? "This build is past planning — the conversation is closed."
              : build.status === "cancelled"
                ? "This build was cancelled."
                : "You can read this conversation but not add to it."}
          </p>
        )}
      </div>
    </>
  );
}
