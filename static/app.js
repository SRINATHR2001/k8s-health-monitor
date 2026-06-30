// ====================================================================
// K8s Health Monitor — Frontend v2
// ====================================================================

const state = {
  clusters: [],
  selected: null,
  selectedClusterObj: null,
  tab: "overview",
  refreshIntervalSec: 30,
  autoRefreshTimer: null,
  expiryTickTimer: null,
  namespace: null,
  namespaces: [],
  warningsOnly: false,
};

// ── Chart registry ────────────────────────────────────────────────────
const charts = {};
function destroyCharts() {
  Object.entries(charts).forEach(([k, c]) => { c.destroy(); delete charts[k]; });
}
function createDonut(id, value, total) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const pct = total > 0 ? value / total : 1;
  const color = total === 0 ? "#e2e8f0" : pct === 1 ? "#10b981" : pct >= 0.8 ? "#f59e0b" : "#ef4444";
  const bg = total === 0 ? ["#e2e8f0","#e2e8f0"] : [color, "#f1f5f9"];
  charts[id] = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: { datasets: [{ data: [value || 0, Math.max(0, total - value) || (total === 0 ? 1 : 0)], backgroundColor: bg, borderWidth: 0, hoverOffset: 0 }] },
    options: {
      responsive: false,
      cutout: "74%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 700, easing: "easeInOutQuart" },
      events: [],
    },
  });
}

// ── API ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    const err = new Error(body.message || r.statusText);
    err.status = r.status; err.body = body;
    throw err;
  }
  return r.json();
}

// ── Formatters ────────────────────────────────────────────────────────
const fmt = {
  age(s) {
    if (s == null) return "—";
    if (s < 60)    return `${s}s`;
    if (s < 3600)  return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },
  countdown(s) {
    if (s == null) return "—";
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
  bytes(n) {
    if (n == null) return "—";
    const u = ["B","Ki","Mi","Gi","Ti"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  },
  cores(c) { return c == null ? "—" : c < 1 ? `${(c * 1000).toFixed(0)}m` : `${c.toFixed(2)}`; },
  pct(n, d)  { return d > 0 ? `${Math.round(100 * n / d)}%` : "—"; },
};

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ── Component helpers ─────────────────────────────────────────────────
function badge(text, cls) {
  return `<span class="badge b-${cls}">${esc(text)}</span>`;
}

function podPhaseBadge(phase, healthy) {
  if (!healthy) {
    const cls = phase === "Pending" ? "yellow" : "red";
    return badge(phase || "Unknown", cls);
  }
  const map = { Running: "green", Succeeded: "blue", Pending: "yellow", Failed: "red", Unknown: "slate" };
  return badge(phase, map[phase] || "slate");
}

function kindBadge(kind) {
  const map = { Deployment: "indigo", StatefulSet: "purple", DaemonSet: "teal", ReplicaSet: "slate", Job: "blue", CronJob: "yellow" };
  return badge(kind, map[kind] || "slate");
}

function restartBadge(n) {
  if (n === 0) return `<span style="color:#cbd5e1;font-size:12px">0</span>`;
  return badge(n, n > 10 ? "red" : n > 3 ? "yellow" : "slate");
}

function resourceBar(used, total) {
  if (used == null || !total) return `<span style="color:#e2e8f0;font-size:12px">—</span>`;
  const pct = Math.min(100, Math.round(100 * used / total));
  const cls = pct >= 85 ? "rf-red" : pct >= 65 ? "rf-yellow" : "rf-green";
  return `<div style="display:flex;align-items:center;gap:8px;min-width:110px">
    <div class="rbar" style="flex:1"><div class="rfill ${cls}" style="width:${pct}%"></div></div>
    <span style="font-size:11px;color:#94a3b8;width:30px;text-align:right">${pct}%</span>
  </div>`;
}

function miniBar(used, total) {
  if (!total || used == null) return "";
  const pct = Math.min(100, Math.round(100 * used / total));
  const cls = pct >= 85 ? "rf-red" : pct >= 65 ? "rf-yellow" : "rf-green";
  return `<div class="rbar" style="width:60px;display:inline-block"><div class="rfill ${cls}" style="width:${pct}%"></div></div>`;
}

function nsFilterHTML() {
  const opts = ['<option value="">All namespaces</option>',
    ...state.namespaces.map(n =>
      `<option value="${esc(n)}"${state.namespace === n ? " selected" : ""}>${esc(n)}</option>`
    ),
  ].join("");
  return `<div style="display:flex;align-items:center;gap:6px">
    <span style="font-size:11px;color:#94a3b8;font-weight:600">NS</span>
    <select onchange="setNamespace(this.value)"
      style="font-size:12px;border:1px solid #e2e8f0;border-radius:8px;padding:4px 8px;background:#fff;color:#334155;outline:none">
      ${opts}
    </select>
  </div>`;
}

function searchInput(placeholder, tbodyId) {
  return `<input type="text" placeholder="${placeholder}"
    oninput="filterRows('${tbodyId}', this.value)"
    style="font-size:12px;border:1px solid #e2e8f0;border-radius:8px;padding:5px 10px;background:#fff;outline:none;width:200px"
    onfocus="this.style.borderColor='#93c5fd'" onblur="this.style.borderColor='#e2e8f0'">`;
}

function filterRows(tbodyId, query) {
  const q = query.toLowerCase();
  document.querySelectorAll(`#${tbodyId} tr`).forEach(row => {
    row.style.display = q && !row.textContent.toLowerCase().includes(q) ? "none" : "";
  });
}

function emptyState(msg) {
  return `<tr><td colspan="20" style="padding:64px;text-align:center;color:#94a3b8;font-size:14px">${msg}</td></tr>`;
}

// ── Cluster sidebar ───────────────────────────────────────────────────
async function loadClusters() {
  state.clusters = await api("/api/clusters");
  renderClusters();
  if (!state.selected && state.clusters.length) {
    selectCluster(state.clusters[0].name);
  } else if (state.selected) {
    state.selectedClusterObj = state.clusters.find(c => c.name === state.selected);
    updateHeader();
    updateReauthBanner();
  }
}

async function loadNamespaces() {
  try { state.namespaces = await api(`/api/clusters/${state.selected}/namespaces`); }
  catch { state.namespaces = []; }
}

function renderClusters() {
  document.getElementById("clusterList").innerHTML = state.clusters.map(c => {
    const active = c.name === state.selected ? "active" : "";
    const dotCls = `sdot sdot-${c.status}`;
    const expiryEl = c.auth_type === "interactive" && c.expires_in_seconds != null
      ? `<span class="text-xs" style="color:${c.expired ? "#f87171" : c.expiring_soon ? "#fbbf24" : "#64748b"}"
             data-expiry-for="${esc(c.name)}" data-expiry-seconds="${c.expires_in_seconds}">
           ${c.expired ? "expired" : fmt.countdown(c.expires_in_seconds)}
         </span>`
      : `<span style="font-size:11px;color:${c.status === "connected" ? "#34d399" : "#f87171"}">${c.status}</span>`;
    const meta = [c.provider, c.region].filter(Boolean).join(" · ");
    return `
      <button onclick="selectCluster('${esc(c.name)}')"
              class="cluster-item ${active} w-full text-left px-3 py-2.5 flex items-center gap-2.5">
        <span class="${dotCls}"></span>
        <span style="flex:1;min-width:0">
          <div style="color:#fff;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</div>
          ${meta ? `<div style="color:#64748b;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(meta)}</div>` : ""}
        </span>
        ${expiryEl}
      </button>`;
  }).join("");
}

function selectCluster(name) {
  state.selected = name;
  state.namespace = null;
  state.selectedClusterObj = state.clusters.find(c => c.name === name);
  renderClusters();
  updateHeader();
  updateReauthBanner();
  loadNamespaces();
  loadTab();
}

function setNamespace(ns) { state.namespace = ns || null; loadTab(); }
function toggleWarningsOnly(checked) { state.warningsOnly = checked; loadTab(); }

function updateHeader() {
  const c = state.selectedClusterObj;
  if (!c) return;
  document.getElementById("clusterTitle").textContent = c.name;
  const bits = [c.provider, c.profile, c.region, c.context && `ctx: ${c.context}`].filter(Boolean);
  document.getElementById("clusterSubtitle").textContent = bits.join(" · ");
  const colors = { connected: "b-green", expired: "b-yellow", error: "b-red", unknown: "b-slate" };
  document.getElementById("clusterStatusBadge").innerHTML =
    `<span class="badge ${colors[c.status] || "b-slate"}">${esc(c.status)}</span>`;
}

// ── Re-auth banner ────────────────────────────────────────────────────
function updateReauthBanner() {
  const c = state.selectedClusterObj;
  const banner = document.getElementById("reauthBanner");
  if (!c || !(c.expired || c.status === "expired" || c.status === "error")) {
    banner.classList.add("hidden"); return;
  }
  banner.classList.remove("hidden");
  let title, hint;
  if (c.status === "error") {
    title = `Connection error on ${c.name}`;
    hint  = c.last_error || "Unknown error connecting to the cluster.";
  } else {
    title = `Session expired on ${c.name}`;
    hint  = c.login_hint || "Run the login command in your terminal, then click \"I've re-authenticated\".";
  }
  document.getElementById("reauthTitle").textContent = title;
  document.getElementById("reauthHint").textContent  = hint;
  document.getElementById("reauthCmd").textContent   = c.login_command || "(no login_command configured)";
}

document.getElementById("reauthCopyBtn").onclick = () => {
  navigator.clipboard.writeText(document.getElementById("reauthCmd").textContent);
  const btn = document.getElementById("reauthCopyBtn");
  const orig = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = orig; }, 1500);
};

document.getElementById("reauthDoneBtn").onclick = async () => {
  const btn = document.getElementById("reauthDoneBtn");
  btn.disabled = true; btn.textContent = "Reconnecting…";
  try {
    const updated = await api(`/api/clusters/${state.selected}/reconnect`, { method: "POST" });
    state.clusters = state.clusters.map(c => c.name === updated.name ? updated : c);
    state.selectedClusterObj = updated;
    renderClusters(); updateReauthBanner();
    if (updated.status === "connected") loadTab();
  } catch (e) { alert("Reconnect failed: " + e.message); }
  finally { btn.disabled = false; btn.textContent = "I've re-authenticated"; }
};

// ── Expiry ticker ─────────────────────────────────────────────────────
function tickExpiry() {
  state.clusters.forEach(c => {
    if (c.auth_type !== "interactive" || c.expires_in_seconds == null || c.expires_in_seconds <= 0) return;
    c.expires_in_seconds = Math.max(0, c.expires_in_seconds - 1);
    const el = document.querySelector(`[data-expiry-for="${c.name}"]`);
    if (!el) return;
    el.textContent = c.expires_in_seconds === 0 ? "expired" : fmt.countdown(c.expires_in_seconds);
    el.style.color = c.expires_in_seconds === 0 ? "#f87171" : c.expires_in_seconds < 300 ? "#fbbf24" : "#64748b";
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(b => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(x => x.classList.remove("tab-active"));
    b.classList.add("tab-active");
    loadTab();
  };
});

async function loadTab() {
  if (!state.selected) {
    document.getElementById("content").innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:120px 0;text-align:center">
        <svg style="width:64px;height:64px;color:#e2e8f0;margin-bottom:16px" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
          <circle cx="12" cy="12" r="3"  stroke="currentColor" stroke-width="1.5"/>
          <line x1="12" y1="2"  x2="12" y2="6"  stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="2"  y1="12" x2="6"  y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p style="color:#475569;font-weight:600;font-size:15px">Select a cluster to begin</p>
        <p style="color:#94a3b8;font-size:13px;margin-top:4px">Choose a cluster from the sidebar</p>
      </div>`;
    return;
  }
  const c = state.selectedClusterObj;
  if (c && c.status !== "connected") {
    document.getElementById("content").innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:100px 0;text-align:center">
        <div style="font-size:48px;color:#fbbf24;margin-bottom:12px">⚠</div>
        <p style="color:#475569;font-weight:600;font-size:15px">Cluster not connected</p>
        ${c.last_error ? `<p style="color:#ef4444;font-size:12px;margin-top:8px;max-width:400px">${esc(c.last_error)}</p>` : ""}
        <p style="color:#94a3b8;font-size:12px;margin-top:8px">Status: <strong>${esc(c.status)}</strong></p>
      </div>`;
    return;
  }
  destroyCharts();
  document.getElementById("loadingIndicator").classList.remove("hidden");
  try {
    if      (state.tab === "overview")   await renderOverview();
    else if (state.tab === "pods")       await renderPods();
    else if (state.tab === "nodes")      await renderNodes();
    else if (state.tab === "workloads")  await renderWorkloads();
    else if (state.tab === "pvcs")       await renderPVCs();
    else if (state.tab === "events")     await renderEvents();
  } catch (e) {
    if (e.status === 503 && e.body?.needs_reauth) { await loadClusters(); }
    else {
      document.getElementById("content").innerHTML = `
        <div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:16px;border-radius:8px;font-size:13px">
          ⚠ ${esc(e.message)}
        </div>`;
    }
  } finally {
    document.getElementById("loadingIndicator").classList.add("hidden");
  }
}

// ── Overview ──────────────────────────────────────────────────────────
async function renderOverview() {
  const o = await api(`/api/clusters/${state.selected}/overview`);

  function statCard(chartId, title, value, total, sub) {
    const pct   = total > 0 ? value / total : 1;
    const allOk = value === total && total > 0;
    const accent = allOk ? "#10b981" : pct < 0.8 ? "#ef4444" : "#f59e0b";
    const numClr = allOk ? "#059669" : pct < 0.8 ? "#dc2626" : "#d97706";
    const pctStr = total > 0 ? `${Math.round(100 * value / total)}%` : "—";
    return `
      <div class="stat-card" style="border-left:4px solid ${accent}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="flex:1;min-width:0">
            <p style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em">${title}</p>
            <p style="margin-top:10px;font-size:30px;font-weight:700;color:${numClr};line-height:1">
              ${value}<span style="font-size:18px;font-weight:400;color:#cbd5e1"> / ${total}</span>
            </p>
            <p style="font-size:12px;color:#94a3b8;margin-top:4px">${sub}</p>
          </div>
          <div style="position:relative;width:60px;height:60px;flex-shrink:0">
            <canvas id="${chartId}" width="60" height="60"></canvas>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
              <span style="font-size:11px;font-weight:700;color:${numClr}">${pctStr}</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  function problemCard(title, items, renderRow) {
    if (!items || items.length === 0) return "";
    return `
      <div class="problem-card">
        <div style="padding:10px 16px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;font-weight:600;color:#334155">${title}</span>
          ${badge(items.length, "red")}
        </div>
        <div>${items.map(renderRow).join("")}</div>
      </div>`;
  }

  document.getElementById("content").innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:20px">
      ${statCard("pods-chart",      "Pods",      o.pods.healthy,      o.pods.total,      fmt.pct(o.pods.healthy, o.pods.total) + " healthy")}
      ${statCard("nodes-chart",     "Nodes",     o.nodes.ready,       o.nodes.total,     fmt.pct(o.nodes.ready,  o.nodes.total) + " ready")}
      ${statCard("workloads-chart", "Workloads", o.workloads.healthy, o.workloads.total, fmt.pct(o.workloads.healthy, o.workloads.total) + " healthy")}
      ${o.pvcs ? statCard("pvcs-chart", "PVCs", o.pvcs.bound, o.pvcs.total, fmt.pct(o.pvcs.bound, o.pvcs.total) + " bound") : ""}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px">
      ${problemCard("Problematic Pods", o.pods.problematic, p => `
        <div style="padding:10px 16px;border-bottom:1px solid #f8fafc;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <span style="font-family:monospace;font-size:11px;color:#64748b">${esc(p.namespace)}/</span>
              <span style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b">${esc(p.name)}</span>
              ${podPhaseBadge(p.phase, false)}
              ${p.reason ? badge(p.reason, "red") : ""}
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:3px">${esc(p.ready)}</div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            ${restartBadge(p.restarts)}
            <div style="font-size:10px;color:#94a3b8;margin-top:2px">restarts</div>
          </div>
        </div>`)}

      ${problemCard("Degraded Workloads", o.workloads.degraded, w => `
        <div style="padding:10px 16px;border-bottom:1px solid #f8fafc;display:flex;align-items:center;justify-content:space-between;gap:8px">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0">
            ${kindBadge(w.kind)}
            <span style="font-family:monospace;font-size:11px;color:#64748b">${esc(w.namespace)}/</span>
            <span style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b">${esc(w.name)}</span>
          </div>
          ${badge(`${w.ready}/${w.replicas} ready`, "red")}
        </div>`)}

      ${problemCard("Not-Ready Nodes", o.nodes.not_ready, n => `
        <div style="padding:10px 16px;border-bottom:1px solid #f8fafc;display:flex;align-items:center;justify-content:space-between">
          <span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(n.name)}</span>
          <div style="display:flex;gap:4px">
            ${n.pressure.length ? n.pressure.map(p => badge(p, "yellow")).join("") : badge("NotReady","red")}
          </div>
        </div>`)}

      ${o.pvcs && o.pvcs.unbound.length ? problemCard("Unbound PVCs", o.pvcs.unbound, p => `
        <div style="padding:10px 16px;border-bottom:1px solid #f8fafc;display:flex;align-items:center;justify-content:space-between">
          <span style="font-family:monospace;font-size:12px">${esc(p.namespace)}/${esc(p.name)}</span>
          <div style="display:flex;align-items:center;gap:8px">
            ${badge(p.status,"red")}
            <span style="font-size:11px;color:#94a3b8">${esc(p.storage_class || "—")}</span>
          </div>
        </div>`) : ""}

      ${problemCard("Recent Warnings", o.recent_warnings, e => `
        <div style="padding:10px 16px;border-bottom:1px solid #f8fafc">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
            <div style="min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                ${badge(e.reason,"yellow")}
                <span style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(e.object||"")}</span>
              </div>
              <p style="font-size:12px;color:#475569;margin-top:4px">${esc(e.message||"")}</p>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:11px;color:#94a3b8">${fmt.age(e.age_seconds)} ago</div>
              <div style="font-size:10px;color:#cbd5e1">×${e.count}</div>
            </div>
          </div>
        </div>`)}
    </div>
  `;

  createDonut("pods-chart",      o.pods.healthy,      o.pods.total);
  createDonut("nodes-chart",     o.nodes.ready,       o.nodes.total);
  createDonut("workloads-chart", o.workloads.healthy, o.workloads.total);
  if (o.pvcs) createDonut("pvcs-chart", o.pvcs.bound, o.pvcs.total);
}

// ── Pods ──────────────────────────────────────────────────────────────
async function renderPods() {
  const params = state.namespace ? `?namespace=${encodeURIComponent(state.namespace)}` : "";
  const pods = await api(`/api/clusters/${state.selected}/pods${params}`);
  pods.sort((a, b) => a.healthy === b.healthy ? 0 : a.healthy ? 1 : -1);

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      ${searchInput("Search pods…", "podBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${pods.length} pods</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Namespace</th><th>Name</th><th>Status</th>
          <th>Ready</th><th>Restarts</th><th>Reason</th>
          <th>Node</th><th>Age</th>
        </tr></thead>
        <tbody id="podBody">
          ${pods.length === 0 ? emptyState("No pods found") : pods.map(p => `
            <tr class="${!p.healthy ? "row-bad" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(p.namespace)}</span></td>
              <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(p.name)}</span></td>
              <td>${podPhaseBadge(p.phase, p.healthy)}</td>
              <td style="font-size:12px;color:${p.ready && p.ready.startsWith("0/") ? "#dc2626" : "#475569"};font-weight:${p.ready && p.ready.startsWith("0/") ? "600" : "400"}">${esc(p.ready)}</td>
              <td>${restartBadge(p.restarts)}</td>
              <td>${p.reason ? badge(p.reason, "red") : '<span style="color:#e2e8f0">—</span>'}</td>
              <td><span style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(p.node || "—")}</span></td>
              <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(p.age_seconds)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

// ── Nodes ─────────────────────────────────────────────────────────────
async function renderNodes() {
  const [nodes, metrics] = await Promise.all([
    api(`/api/clusters/${state.selected}/nodes`),
    api(`/api/clusters/${state.selected}/metrics/nodes`).catch(() => []),
  ]);
  const byName = Object.fromEntries(metrics.map(m => [m.name, m]));
  const hasMet = metrics.length > 0;

  const totCpuA = nodes.reduce((s, n) => s + (n.allocatable?.cpu_cores    || 0), 0);
  const totMemA = nodes.reduce((s, n) => s + (n.allocatable?.memory_bytes || 0), 0);
  const totCpuU = metrics.reduce((s, m) => s + (m.cpu_cores    || 0), 0);
  const totMemU = metrics.reduce((s, m) => s + (m.memory_bytes || 0), 0);

  const summaryBar = hasMet ? `
    <div class="stat-card" style="margin-bottom:16px">
      <p style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">
        Cluster Resource Utilization
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
            <span style="font-weight:600;color:#334155">CPU</span>
            <span style="color:#94a3b8">${fmt.cores(totCpuU)} / ${fmt.cores(totCpuA)} cores</span>
          </div>
          ${resourceBar(totCpuU, totCpuA)}
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">
            <span style="font-weight:600;color:#334155">Memory</span>
            <span style="color:#94a3b8">${fmt.bytes(totMemU)} / ${fmt.bytes(totMemA)}</span>
          </div>
          ${resourceBar(totMemU, totMemA)}
        </div>
      </div>
    </div>` : "";

  document.getElementById("content").innerHTML = `
    ${summaryBar}
    <div class="filter-bar">
      ${searchInput("Search nodes…", "nodeBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${nodes.length} nodes</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Name</th><th>Status</th><th>Pressure</th>
          <th>CPU Used</th><th style="min-width:140px">CPU %</th>
          <th>Mem Used</th><th style="min-width:140px">Mem %</th>
          <th>Instance</th><th>Zone</th><th>Version</th>
        </tr></thead>
        <tbody id="nodeBody">
          ${nodes.length === 0 ? emptyState("No nodes found") : nodes.map(n => {
            const m   = byName[n.name];
            const cls = !n.ready ? "row-bad" : n.pressure.length ? "row-warn" : "";
            return `
              <tr class="${cls}">
                <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(n.name)}</span></td>
                <td>${n.ready ? badge("Ready","green") : badge("NotReady","red")}</td>
                <td>${n.pressure.length ? n.pressure.map(p => badge(p,"yellow")).join(" ") : '<span style="color:#e2e8f0;font-size:12px">—</span>'}</td>
                <td style="font-size:12px;color:#475569">${m ? fmt.cores(m.cpu_cores)    : '<span style="color:#e2e8f0">—</span>'}</td>
                <td>${m && n.allocatable?.cpu_cores    ? resourceBar(m.cpu_cores,    n.allocatable.cpu_cores)    : '<span style="color:#e2e8f0;font-size:12px">—</span>'}</td>
                <td style="font-size:12px;color:#475569">${m ? fmt.bytes(m.memory_bytes) : '<span style="color:#e2e8f0">—</span>'}</td>
                <td>${m && n.allocatable?.memory_bytes ? resourceBar(m.memory_bytes, n.allocatable.memory_bytes) : '<span style="color:#e2e8f0;font-size:12px">—</span>'}</td>
                <td style="font-size:11px;color:#64748b">${esc(n.instance_type || "—")}</td>
                <td style="font-size:11px;color:#64748b">${esc(n.zone || "—")}</td>
                <td style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(n.kubelet_version || "—")}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${!hasMet ? `<div style="padding:10px 16px;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;background:#f8fafc">
        Metrics unavailable — install metrics-server to see CPU/memory usage.
      </div>` : ""}
    </div>`;
}

// ── Workloads ─────────────────────────────────────────────────────────
async function renderWorkloads() {
  const params = state.namespace ? `?namespace=${encodeURIComponent(state.namespace)}` : "";
  const wls = await api(`/api/clusters/${state.selected}/workloads${params}`);
  wls.sort((a, b) => a.healthy === b.healthy ? 0 : a.healthy ? 1 : -1);

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      ${searchInput("Search workloads…", "workloadBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${wls.length} workloads</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Kind</th><th>Namespace</th><th>Name</th>
          <th>Replicas</th><th style="min-width:160px">Ready</th>
          <th>Updated</th><th>Rollout</th><th>Age</th>
        </tr></thead>
        <tbody id="workloadBody">
          ${wls.length === 0 ? emptyState("No workloads found") : wls.map(w => {
            const notReady = w.ready < w.replicas;
            return `
              <tr class="${!w.healthy ? "row-bad" : ""}">
                <td>${kindBadge(w.kind)}</td>
                <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(w.namespace)}</span></td>
                <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(w.name)}</span></td>
                <td style="font-size:12px;color:#475569">${w.replicas}</td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:4px">
                    <span style="font-size:12px;font-weight:${notReady ? 600 : 400};color:${notReady ? "#dc2626" : "#475569"}">${w.ready} / ${w.replicas}</span>
                    ${w.replicas > 0 ? miniBar(w.ready, w.replicas) : ""}
                  </div>
                </td>
                <td style="font-size:12px;color:#475569">${w.updated}</td>
                <td>${w.rollout_complete ? badge("Complete","green") : badge("In Progress","yellow")}</td>
                <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(w.age_seconds)}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

// ── PVCs ──────────────────────────────────────────────────────────────
async function renderPVCs() {
  const params = state.namespace ? `?namespace=${encodeURIComponent(state.namespace)}` : "";
  const pvcs = await api(`/api/clusters/${state.selected}/pvcs${params}`);
  pvcs.sort((a, b) => a.healthy === b.healthy ? 0 : a.healthy ? 1 : -1);

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      ${searchInput("Search PVCs…", "pvcBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${pvcs.length} PVCs</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Namespace</th><th>Name</th><th>Status</th>
          <th>Capacity</th><th>Storage Class</th><th>Access Modes</th>
          <th>Volume</th><th>Age</th>
        </tr></thead>
        <tbody id="pvcBody">
          ${pvcs.length === 0 ? emptyState("No PVCs found") : pvcs.map(p => `
            <tr class="${!p.healthy ? "row-bad" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(p.namespace)}</span></td>
              <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(p.name)}</span></td>
              <td>${badge(p.status, p.healthy ? "green" : "red")}</td>
              <td>${badge(fmt.bytes(p.capacity_bytes), "slate")}</td>
              <td style="font-size:12px;color:#475569">${esc(p.storage_class || "—")}</td>
              <td>${(p.access_modes || []).map(m => badge(m, "slate")).join(" ") || '<span style="color:#e2e8f0">—</span>'}</td>
              <td><span style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(p.volume_name || "—")}</span></td>
              <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(p.age_seconds)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

// ── Events ────────────────────────────────────────────────────────────
async function renderEvents() {
  const p = new URLSearchParams();
  if (state.namespace)   p.set("namespace",    state.namespace);
  if (state.warningsOnly) p.set("warnings_only","true");
  const events = await api(`/api/clusters/${state.selected}/events${p.toString() ? "?" + p : ""}`);

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none">
        <input type="checkbox" ${state.warningsOnly ? "checked" : ""} onchange="toggleWarningsOnly(this.checked)"
          style="width:14px;height:14px;accent-color:#f59e0b;cursor:pointer">
        <span style="font-size:12px;color:#475569;font-weight:500">Warnings only</span>
      </label>
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${events.length} events</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>When</th><th>Type</th><th>Reason</th>
          <th>Object</th><th>Message</th><th>Count</th>
        </tr></thead>
        <tbody>
          ${events.length === 0 ? emptyState("No events") : events.map(e => {
            const warn = e.type === "Warning";
            return `
              <tr class="${warn ? "row-warn" : ""}">
                <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(e.age_seconds)} ago</td>
                <td>${badge(e.type, warn ? "yellow" : "slate")}</td>
                <td>${badge(e.reason, warn ? "yellow" : "slate")}</td>
                <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(e.namespace || "")}/${esc(e.object || "")}</span></td>
                <td style="font-size:12px;color:#475569;max-width:400px">${esc(e.message || "")}</td>
                <td>${badge("×" + e.count, "slate")}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

// ── Refresh wiring ────────────────────────────────────────────────────
document.getElementById("refreshBtn").onclick = async () => {
  await loadClusters();
  await loadTab();
};

async function init() {
  try {
    const cfg = await api("/api/config");
    state.refreshIntervalSec = cfg.refresh_interval_seconds || 30;
    document.getElementById("refreshInterval").textContent = state.refreshIntervalSec;
  } catch {}

  await loadClusters();

  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(async () => {
    await loadClusters();
    await loadTab();
    document.getElementById("lastRefresh").textContent = "Updated " + new Date().toLocaleTimeString();
  }, state.refreshIntervalSec * 1000);

  if (state.expiryTickTimer) clearInterval(state.expiryTickTimer);
  state.expiryTickTimer = setInterval(tickExpiry, 1000);

  document.getElementById("lastRefresh").textContent = "Updated " + new Date().toLocaleTimeString();
}

init();
