import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, apiError, invalidateGetCache } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { Card, Btn, PageHeader } from "@/components/common";
import { Sparkles, Send, Plus, Trash2, MessageSquare } from "lucide-react";
import { listViewState, loadListRequest } from "@/lib/listRequest.mjs";

const SUGGESTIONS = ["Who owes me money right now?", "What is the diesel price in Kokstad today?", "Summarise this week's expenses and estimated result", "Which orders are urgent to send?"];
const BASE = `${process.env.REACT_APP_BACKEND_URL}/api`;

function Bubble({ m, idx }) {
  const mine = m.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid={`chat-message-${idx}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed ${mine ? "bg-primary text-white rounded-br-sm" : "bg-white border border-border text-slate-700 rounded-bl-sm"}`}>
        {m.content || <span className="inline-flex gap-1 text-slate-400"><span className="animate-pulse">Thinking</span>…</span>}
      </div>
    </div>
  );
}

function SessionList({ sessions, loading, error, active, onPick, onNew, onDelete, onRetry }) {
  const sessionState = listViewState({ loading, error, items: sessions });

  return (
    <Card className="p-3 h-full flex flex-col">
      <Btn onClick={onNew} className="w-full mb-3" data-testid="new-chat-btn"><Plus size={16} /> New chat</Btn>
      <div className="space-y-1 overflow-y-auto flex-1">
        {sessionState === "loading" && (
          <p className="px-2 text-xs text-slate-400" role="status">Loading conversations...</p>
        )}
        {sessionState === "error" && (
          <div className="space-y-2 px-2 py-3" role="alert">
            <p className="text-xs text-red-700">Conversations could not be loaded: {error}</p>
            <Btn variant="outline" className="px-3 py-1.5 text-xs" onClick={onRetry} data-testid="assistant-conversations-retry">
              Retry
            </Btn>
          </div>
        )}
        {sessionState === "empty" && (
          <p className="px-2 text-xs text-slate-400" data-testid="assistant-conversations-empty">No conversations yet.</p>
        )}
        {(sessionState === "items" || (sessionState === "error" && sessions.length > 0)) && sessions.map((s) => (
          <div key={s.id} className={`group flex items-center gap-2 rounded-lg px-2 py-2 cursor-pointer text-sm ${active === s.id ? "bg-blue-50 text-primary" : "hover:bg-slate-50 text-slate-600"}`} onClick={() => onPick(s.id)} data-testid={`chat-session-${s.id}`}>
            <MessageSquare size={14} className="shrink-0" />
            <div className="flex-1 min-w-0"><p className="truncate font-semibold">{s.title}</p><p className="text-[10px] text-slate-400">{fmtDateTime(s.updated_at)}</p></div>
            <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }} className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600" data-testid={`delete-chat-${s.id}`}><Trash2 size={13} /></button>
          </div>))}
      </div>
    </Card>
  );
}

export default function Assistant() {
  const [sessionsRequest, setSessionsRequest] = useState({ items: [], loading: true, error: "" });
  const [sid, setSid] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const loadSessions = ({ showLoading = true } = {}) => loadListRequest({
    request: () => api.get("/assistant/sessions"),
    setState: setSessionsRequest,
    errorMessage: apiError,
    showLoading,
  });
  useEffect(() => { void loadSessions(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const pick = async (id) => {
    if (busy) return;
    try { const s = await api.get(`/assistant/sessions/${id}`); setSid(id); setMessages(s.messages); } catch (e) { toast.error(apiError(e)); }
  };
  const remove = async (id) => {
    if (!window.confirm("Delete this conversation?")) return;
    try {
      await api.del(`/assistant/sessions/${id}`);
      if (id === sid) { setSid(null); setMessages([]); }
      await loadSessions({ showLoading: false });
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const send = async (text) => {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput(""); setBusy(true);
    setMessages((m) => [...m, { role: "user", content: msg }, { role: "assistant", content: "" }]);
    const append = (t) => setMessages((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + t }; return c; });
    try {
      invalidateGetCache();
      const res = await fetch(`${BASE}/assistant/chat`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("token") || ""}` },
        body: JSON.stringify({ message: msg, session_id: sid }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || `Error ${res.status}`); }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n"); buf = chunks.pop();
        for (const c of chunks) {
          if (!c.startsWith("data: ")) continue;
          const ev = JSON.parse(c.slice(6));
          if (ev.type === "session") setSid(ev.session_id);
          else if (ev.type === "delta") append(ev.content);
          else if (ev.type === "status") toast.info(ev.content);
          else if (ev.type === "error") { append(`\n\n⚠ ${ev.message}`); toast.error("Assistant error"); }
        }
      }
      await loadSessions({ showLoading: false });
    } catch (e) {
      setMessages((m) => m.slice(0, -1)); toast.error(e.message); setInput(msg);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="AI Business Assistant" subtitle="Your ERP data + live web search (with sources) · GPT-5.2" />
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-13rem)] min-h-[480px]">
        <div className="hidden lg:block"><SessionList
          sessions={sessionsRequest.items}
          loading={sessionsRequest.loading}
          error={sessionsRequest.error}
          active={sid}
          onPick={pick}
          onNew={() => { setSid(null); setMessages([]); }}
          onDelete={remove}
          onRetry={() => { void loadSessions(); }}
        /></div>
        <Card className="lg:col-span-3 flex flex-col overflow-hidden bg-slate-50/60">
          <div className="flex-1 overflow-y-auto p-5 space-y-4" data-testid="chat-messages">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center">
                <div className="h-14 w-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center mb-4"><Sparkles size={26} /></div>
                <p className="font-bold text-slate-800 font-display">How can I help with SUPER IQ-FOAM today?</p>
                <p className="text-xs text-slate-400 mt-1 mb-5">Answers use your real invoices, stock, orders, fleet and expenses. Read-only.</p>
                <div className="grid sm:grid-cols-2 gap-2 max-w-xl w-full">
                  {SUGGESTIONS.map((s, i) => <button key={s} onClick={() => send(s)} className="text-left text-sm rounded-xl border border-border bg-white px-4 py-3 hover:border-primary transition-colors" data-testid={`chat-suggestion-${i}`}>{s}</button>)}
                </div>
              </div>
            ) : messages.map((m, i) => <Bubble key={i} m={m} idx={i} />)}
            <div ref={endRef} />
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(); }} className="border-t border-border bg-white p-3 flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about debtors, stock, orders, expenses..." disabled={busy}
              className="flex-1 rounded-lg border border-input px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30" data-testid="chat-input" />
            <Btn type="submit" disabled={busy || !input.trim()} data-testid="chat-send-btn"><Send size={16} /> {busy ? "..." : "Send"}</Btn>
          </form>
        </Card>
      </div>
    </div>
  );
}
