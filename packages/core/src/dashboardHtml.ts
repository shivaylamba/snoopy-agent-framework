/**
 * Single-file dashboard served from tracesServer at `/`. Pure HTML + vanilla
 * JS — no build step, no CDN dependencies (every byte is in this string).
 *
 * Reads from `/traces` and `/traces/:runId` every 2s. Tuned for a live demo:
 * stats header (totals, success rate, p50/p99 latency), agent cards with
 * activity sparklines, trace timeline with proportional timing bars.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>snoopy — distributed agent traces</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0c12;
    --bg-soft: #11141d;
    --bg-hover: #1a1f2e;
    --bg-active: #1f2940;
    --border: #1e2330;
    --border-strong: #2a3142;
    --fg: #e3e7f0;
    --fg-dim: #8a93a8;
    --fg-faint: #5d6679;
    --accent: #7c5cff;
    --accent-soft: #5d4ad1;
    --ok: #5ee68c;
    --warn: #f5c451;
    --err: #ff7a7a;
    --info: #6bb4ff;
    --magenta: #c084fc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%; background: var(--bg); color: var(--fg);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Inter, sans-serif;
  }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }

  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }

  /* ── header ────────────────────────────────────────────── */
  header.bar {
    display: flex; align-items: center; gap: 24px;
    padding: 14px 22px; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, #0d1019, #0a0c12);
  }
  .brand {
    display: flex; align-items: center; gap: 12px;
    font-weight: 700; letter-spacing: 0.5px;
  }
  .brand .logo {
    width: 26px; height: 26px; border-radius: 7px;
    background: linear-gradient(135deg, var(--accent), #ff5fa2);
    box-shadow: 0 0 22px rgba(124, 92, 255, 0.45);
    display: grid; place-items: center; font-size: 13px;
  }
  .brand .name { font-size: 14px; }
  .brand .tag { color: var(--fg-faint); font-size: 11px; margin-left: 4px; }

  .stats { display: flex; gap: 20px; flex: 1; justify-content: center; }
  .stat { display: flex; flex-direction: column; align-items: center; min-width: 80px; }
  .stat .v { font-size: 18px; font-weight: 600; line-height: 1.1; }
  .stat .l { font-size: 10px; color: var(--fg-faint); text-transform: uppercase;
             letter-spacing: 0.8px; margin-top: 3px; }
  .stat.ok .v { color: var(--ok); }
  .stat.err .v { color: var(--err); }
  .stat.lat .v { color: var(--info); }

  .pulse { display: flex; align-items: center; gap: 6px; color: var(--fg-dim); font-size: 11px; }
  .pulse .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--ok);
    box-shadow: 0 0 6px var(--ok); animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }

  /* ── body ─────────────────────────────────────────────── */
  main { display: grid; grid-template-columns: 280px 1fr; overflow: hidden; }
  aside {
    border-right: 1px solid var(--border); background: var(--bg-soft);
    overflow-y: auto;
  }
  .filt { padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .filt input {
    width: 100%; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--fg); padding: 7px 10px; font: inherit; border-radius: 6px;
  }
  .filt input:focus { outline: none; border-color: var(--accent); }

  .agents { padding: 8px 0; list-style: none; }
  .agent {
    padding: 12px 16px; cursor: pointer; border-left: 3px solid transparent;
    display: grid; grid-template-columns: 1fr auto; gap: 4px 8px;
    align-items: center;
  }
  .agent:hover { background: var(--bg-hover); }
  .agent.sel { background: var(--bg-active); border-left-color: var(--accent); }
  .agent .nm { font-weight: 500; }
  .agent .ct { color: var(--fg-faint); font-size: 11px; }
  .agent .sp { grid-column: 1 / -1; display: flex; gap: 2px; height: 14px;
               margin-top: 2px; }
  .agent .sp .b { flex: 1; background: var(--border-strong); border-radius: 2px;
                  min-height: 3px; opacity: 0.55; }
  .agent .sp .b.ok { background: var(--ok); }
  .agent .sp .b.err { background: var(--err); }

  /* ── runs panel ───────────────────────────────────────── */
  .runs { overflow-y: auto; padding: 18px 22px; }
  .runs h2 { font-size: 12px; color: var(--fg-faint); letter-spacing: 1.2px;
             text-transform: uppercase; margin-bottom: 12px; font-weight: 600; }
  .run {
    border: 1px solid var(--border); border-radius: 9px; margin-bottom: 12px;
    background: var(--bg-soft); transition: border-color 0.15s;
  }
  .run:hover { border-color: var(--border-strong); }
  .run.open { border-color: var(--accent-soft); }
  .run > .hd {
    display: grid; grid-template-columns: 24px 1fr auto auto auto; gap: 14px;
    align-items: center; padding: 12px 16px; cursor: pointer;
  }
  .run > .hd:hover { background: var(--bg-hover); }
  .run .status { font-weight: 700; font-size: 15px; text-align: center; }
  .run.ok .status { color: var(--ok); }
  .run.err .status { color: var(--err); }
  .run.pending .status { color: var(--warn); }
  .run .ttl { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .run .ttl .nm { font-weight: 600; }
  .run .ttl .rid { color: var(--fg-faint); font-size: 11px; }
  .run .meta { color: var(--fg-dim); font-size: 11px; text-align: right; }
  .run .meta .age { color: var(--fg-faint); }
  .run .dur { color: var(--info); font-size: 12px; font-weight: 500;
              padding: 3px 8px; background: rgba(107, 180, 255, 0.1);
              border-radius: 4px; }
  .run.err .dur { color: var(--err); background: rgba(255, 122, 122, 0.1); }
  .run .chev { color: var(--fg-faint); transition: transform 0.15s; }
  .run.open .chev { transform: rotate(90deg); }

  .body { border-top: 1px solid var(--border); padding: 14px 18px 16px; display: none; }
  .run.open .body { display: block; }

  /* ── timeline ─────────────────────────────────────────── */
  .timeline { position: relative; padding-left: 16px; }
  .timeline::before {
    content: ""; position: absolute; left: 4px; top: 6px; bottom: 6px;
    width: 1px; background: var(--border-strong);
  }
  .ev {
    position: relative; padding: 6px 0 6px 16px; margin-left: -16px;
  }
  .ev::before {
    content: ""; position: absolute; left: 1px; top: 12px;
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--fg-faint); border: 2px solid var(--bg-soft);
  }
  .ev.start::before { background: var(--info); }
  .ev.end::before   { background: var(--ok); }
  .ev.error::before { background: var(--err); }
  .ev.spawn::before, .ev.call::before { background: var(--magenta); }
  .ev .row { display: flex; align-items: center; gap: 10px; }
  .ev .kind { font-weight: 500; }
  .ev .kind.start, .ev .kind.end { color: var(--ok); }
  .ev .kind.error { color: var(--err); }
  .ev .kind.spawn, .ev .kind.call { color: var(--magenta); }
  .ev .ofs { color: var(--fg-faint); font-size: 11px; font-family: ui-monospace; }
  .ev .bar {
    flex: 1; height: 4px; background: var(--border); border-radius: 2px;
    overflow: hidden; max-width: 280px;
  }
  .ev .bar > i {
    display: block; height: 100%; background: var(--info); border-radius: 2px;
    animation: grow 0.3s ease-out;
  }
  @keyframes grow { from { width: 0 } }
  .ev pre {
    margin: 6px 0 0 0; padding: 8px 10px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 5px; color: #b8c0d4;
    font-family: ui-monospace; font-size: 11px;
    white-space: pre-wrap; word-break: break-word;
    max-height: 220px; overflow-y: auto;
  }

  .empty {
    color: var(--fg-faint); padding: 60px 20px; text-align: center;
  }
  .empty .big { font-size: 22px; margin-bottom: 8px; color: var(--fg-dim); }

  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
  }
  .pill.sev1 { background: rgba(255, 122, 122, 0.2); color: var(--err); }
  .pill.sev2 { background: rgba(245, 196, 81, 0.18); color: var(--warn); }
  .pill.sev3 { background: rgba(107, 180, 255, 0.18); color: var(--info); }
</style>
</head>
<body>
<div class="app">
  <header class="bar">
    <div class="brand">
      <div class="logo">🐾</div>
      <div><span class="name">snoopy</span><span class="tag">/ distributed agent traces</span></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="v" id="kRuns">0</div><div class="l">runs</div></div>
      <div class="stat ok"><div class="v" id="kOk">0</div><div class="l">ok</div></div>
      <div class="stat err"><div class="v" id="kErr">0</div><div class="l">errors</div></div>
      <div class="stat lat"><div class="v" id="kP50">–</div><div class="l">p50</div></div>
      <div class="stat lat"><div class="v" id="kP99">–</div><div class="l">p99</div></div>
      <div class="stat"><div class="v" id="kAgents">0</div><div class="l">agents</div></div>
    </div>
    <div class="pulse"><div class="dot"></div><span id="pulse">live</span></div>
  </header>

  <main>
    <aside>
      <div class="filt"><input id="filter" placeholder="filter agent id…"></div>
      <ul class="agents" id="agents"></ul>
    </aside>
    <div class="runs">
      <h2 id="runsTitle">Recent runs</h2>
      <div id="runsList"></div>
    </div>
  </main>
</div>

<script>
const S = {
  selectedAgent: null,
  filter: "",
  runs: new Map(),       // runId -> { agentId, events: [] }
  expanded: new Set(),
};
window.S = S;

async function poll() {
  try {
    const url = new URL("/traces", location.origin);
    url.searchParams.set("limit", "500");
    const res = await fetch(url);
    if (!res.ok) return;
    const body = await res.json();
    ingest(body.spans || []);
    render();
    document.getElementById("pulse").textContent = "live";
  } catch (e) {
    document.getElementById("pulse").textContent = "offline";
  }
}

function ingest(spans) {
  for (const s of spans) {
    const r = S.runs.get(s.runId) || { runId: s.runId, agentId: s.agentId, events: [] };
    // de-dup events by ts+event combo
    const k = s.event + ":" + s.ts;
    if (!r._seen) r._seen = new Set();
    if (!r._seen.has(k)) { r._seen.add(k); r.events.push(s); }
    S.runs.set(s.runId, r);
  }
}

function render() {
  const runs = [...S.runs.values()];
  for (const r of runs) {
    r.events.sort((a, b) => a.ts - b.ts);
    r.start = r.events.find(e => e.event === "agent.start");
    r.end = r.events.find(e => e.event === "agent.end");
    r.error = r.events.find(e => e.event === "agent.error");
    r.tEnd = r.end || r.error;
    r.dur = r.tEnd && r.start ? r.tEnd.ts - r.start.ts : null;
    r.state = r.error ? "err" : r.end ? "ok" : "pending";
    r.latest = Math.max(...r.events.map(e => e.ts), 0);
  }

  // ── stats
  const completedDurs = runs.filter(r => r.dur != null && r.state === "ok").map(r => r.dur).sort((a,b)=>a-b);
  const oks = runs.filter(r => r.state === "ok").length;
  const errs = runs.filter(r => r.state === "err").length;
  document.getElementById("kRuns").textContent = runs.length;
  document.getElementById("kOk").textContent = oks;
  document.getElementById("kErr").textContent = errs;
  document.getElementById("kP50").textContent = completedDurs.length
    ? fmtDur(completedDurs[Math.floor(completedDurs.length * 0.5)]) : "–";
  document.getElementById("kP99").textContent = completedDurs.length
    ? fmtDur(completedDurs[Math.floor(completedDurs.length * 0.99)] || completedDurs[completedDurs.length - 1]) : "–";

  // ── sidebar
  const agentMap = new Map();
  for (const r of runs) {
    const a = agentMap.get(r.agentId) || { id: r.agentId, runs: [], ok: 0, err: 0 };
    a.runs.push(r); if (r.state === "ok") a.ok++; if (r.state === "err") a.err++;
    agentMap.set(r.agentId, a);
  }
  document.getElementById("kAgents").textContent = agentMap.size;

  const filt = S.filter.toLowerCase();
  const agentsList = [...agentMap.values()]
    .filter(a => !filt || a.id.toLowerCase().includes(filt))
    .sort((a, b) => b.runs.length - a.runs.length);

  const aul = document.getElementById("agents");
  aul.innerHTML = "";
  const all = el("li", "agent" + (S.selectedAgent ? "" : " sel"),
    \`<span class="nm">all</span><span class="ct">\${runs.length}</span>\`);
  all.onclick = () => { S.selectedAgent = null; render(); };
  aul.appendChild(all);
  for (const a of agentsList) {
    const sp = a.runs.slice(-12).map(r =>
      \`<div class="b \${r.state}" style="opacity:\${0.3 + (r.dur ? Math.min(r.dur/5000, 1) * 0.7 : 0.4)}"></div>\`
    ).join("");
    const li = el("li", "agent" + (S.selectedAgent === a.id ? " sel" : ""),
      \`<span class="nm">\${escape(a.id)}</span>
       <span class="ct">\${a.runs.length}</span>
       <div class="sp">\${sp}</div>\`);
    li.onclick = () => { S.selectedAgent = a.id; render(); };
    aul.appendChild(li);
  }

  // ── runs panel
  const filteredRuns = (S.selectedAgent
    ? runs.filter(r => r.agentId === S.selectedAgent)
    : runs).sort((a, b) => b.latest - a.latest);

  document.getElementById("runsTitle").textContent =
    (S.selectedAgent ? S.selectedAgent + " · " : "") + filteredRuns.length + " runs";

  const list = document.getElementById("runsList");
  list.innerHTML = "";
  if (filteredRuns.length === 0) {
    list.innerHTML = '<div class="empty"><div class="big">🛰</div><div>No runs yet.</div>' +
      '<div style="font-size:11px;margin-top:6px">Fire an agent to see it land here.</div></div>';
    return;
  }
  for (const r of filteredRuns.slice(0, 60)) list.appendChild(renderRun(r));
}

function renderRun(r) {
  const open = S.expanded.has(r.runId);
  const status = r.state === "err" ? "✗" : r.state === "ok" ? "✓" : "•";
  const dur = r.dur != null ? fmtDur(r.dur) : "running…";
  const age = fmtAge(Date.now() - r.latest);
  const sev = r.end?.data?.result?.severity;

  const div = el("div", "run " + r.state + (open ? " open" : ""), "");
  div.innerHTML =
    \`<div class="hd">
       <div class="status">\${status}</div>
       <div class="ttl">
         <span class="nm">\${escape(r.agentId)} \${sev ? '<span class="pill '+sev+'">'+sev+'</span>' : ''}</span>
         <span class="rid mono">\${escape(r.runId)}</span>
       </div>
       <div class="dur">\${dur}</div>
       <div class="meta"><span class="age">\${age}</span></div>
       <div class="chev">›</div>
     </div>
     <div class="body">\${open ? renderTimeline(r) : ""}</div>\`;

  div.querySelector(".hd").onclick = () => {
    if (S.expanded.has(r.runId)) S.expanded.delete(r.runId);
    else S.expanded.add(r.runId);
    render();
  };
  return div;
}

function renderTimeline(r) {
  if (!r.start) return '<div class="empty">No start event yet.</div>';
  const span = (r.tEnd?.ts || r.latest) - r.start.ts || 1;
  let html = '<div class="timeline">';
  for (const e of r.events) {
    const ofs = e.ts - r.start.ts;
    const widthPct = Math.max(1, Math.min(100, (ofs / span) * 100));
    const kind = (e.event.split(".").pop() || e.event);
    html += \`<div class="ev \${kind}">
      <div class="row">
        <span class="kind \${kind}">\${escape(e.event)}</span>
        <span class="ofs">+\${fmtDur(ofs)}</span>
        <div class="bar"><i style="width:\${widthPct}%"></i></div>
      </div>
      \${e.data ? '<pre>' + escape(typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)) + '</pre>' : ''}
    </div>\`;
  }
  html += '</div>';
  return html;
}

function el(tag, cls, html) { const e = document.createElement(tag); e.className = cls; e.innerHTML = html; return e; }
function escape(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function fmtDur(ms) {
  if (ms == null) return "–";
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return (ms / 60_000).toFixed(1) + "m";
}
function fmtAge(ms) {
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
  return Math.floor(ms / 3_600_000) + "h ago";
}

document.getElementById("filter").addEventListener("input", e => {
  S.filter = e.target.value; render();
});

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
