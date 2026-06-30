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
    else if (state.tab === "cronjobs")   await renderCronJobs();
    else if (state.tab === "services")   await renderServices();
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
          <th>Node</th><th>Age</th><th>Actions</th>
        </tr></thead>
        <tbody id="podBody">
          ${pods.length === 0 ? emptyState("No pods found") : pods.map(p => {
            const firstCtr = (p.container_names || [])[0] || "";
            return `
            <tr class="${!p.healthy ? "row-bad" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(p.namespace)}</span></td>
              <td>
                <button onclick="openDescribe('pod','${esc(p.namespace)}','${esc(p.name)}')"
                  style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b;background:none;border:none;cursor:pointer;padding:0;text-align:left;text-decoration:none">
                  ${esc(p.name)}
                </button>
              </td>
              <td>${podPhaseBadge(p.phase, p.healthy)}</td>
              <td style="font-size:12px;color:${p.ready && p.ready.startsWith("0/") ? "#dc2626" : "#475569"};font-weight:${p.ready && p.ready.startsWith("0/") ? "600" : "400"}">${esc(p.ready)}</td>
              <td>${restartBadge(p.restarts)}</td>
              <td>${p.reason ? badge(p.reason, "red") : '<span style="color:#e2e8f0">—</span>'}</td>
              <td><span style="font-family:monospace;font-size:11px;color:#94a3b8">${esc(p.node || "—")}</span></td>
              <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(p.age_seconds)}</td>
              <td style="white-space:nowrap">
                <button onclick="openLogs('${esc(state.selected)}','${esc(p.namespace)}','${esc(p.name)}','${esc(firstCtr)}')"
                  style="font-size:11px;padding:2px 8px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;cursor:pointer;color:#475569">Logs</button>
                <button onclick="openExec('${esc(state.selected)}','${esc(p.namespace)}','${esc(p.name)}','${esc(firstCtr)}')"
                  style="font-size:11px;padding:2px 8px;background:#dbeafe;border:1px solid #bfdbfe;border-radius:5px;cursor:pointer;color:#1e40af;margin-left:4px">Exec</button>
              </td>
            </tr>`;
          }).join("")}
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
                <td>
                  <button onclick="openDescribe('node','${esc(n.name)}')"
                    style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b;background:none;border:none;cursor:pointer;padding:0;text-decoration:none">
                    ${esc(n.name)}
                  </button>
                </td>
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
                <td>
                  <button onclick="openDescribe('workload','${esc(w.namespace)}','${esc(w.kind)}','${esc(w.name)}')"
                    style="font-family:monospace;font-size:12px;font-weight:600;color:#1e293b;background:none;border:none;cursor:pointer;padding:0;text-decoration:none">
                    ${esc(w.name)}
                  </button>
                </td>
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
          <th>Bound to Pods</th><th>Age</th>
        </tr></thead>
        <tbody id="pvcBody">
          ${pvcs.length === 0 ? emptyState("No PVCs found") : pvcs.map(p => {
            const podList = (p.pods || []).map(pod =>
              `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;background:#f1f5f9;padding:1px 6px;border-radius:4px;margin:1px">
                <span style="width:6px;height:6px;border-radius:50%;background:${pod.phase === "Running" ? "#10b981" : "#f59e0b"};display:inline-block;flex-shrink:0"></span>
                ${esc(pod.name)}
              </span>`
            ).join("") || '<span style="color:#cbd5e1;font-size:11px">unattached</span>';
            return `
            <tr class="${!p.healthy ? "row-bad" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(p.namespace)}</span></td>
              <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(p.name)}</span></td>
              <td>${badge(p.status, p.healthy ? "green" : "red")}</td>
              <td>${badge(fmt.bytes(p.capacity_bytes), "slate")}</td>
              <td style="font-size:12px;color:#475569">${esc(p.storage_class || "—")}</td>
              <td>${(p.access_modes || []).map(m => badge(m, "slate")).join(" ") || '<span style="color:#e2e8f0">—</span>'}</td>
              <td style="max-width:220px">${podList}</td>
              <td style="font-size:11px;color:#94a3b8;white-space:nowrap">${fmt.age(p.age_seconds)}</td>
            </tr>`;
          }).join("")}
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

// ── CronJobs ──────────────────────────────────────────────────────────
async function renderCronJobs() {
  const params = state.namespace ? `?namespace=${encodeURIComponent(state.namespace)}` : "";
  const [crons, jobs] = await Promise.all([
    api(`/api/clusters/${state.selected}/cronjobs${params}`),
    api(`/api/clusters/${state.selected}/jobs${params}`).catch(() => []),
  ]);
  crons.sort((a, b) => a.healthy === b.healthy ? 0 : a.healthy ? 1 : -1);
  jobs.sort((a, b) => a.healthy === b.healthy ? 0 : a.healthy ? 1 : -1);

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      ${searchInput("Search…", "cronBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${crons.length} cron jobs</span>
    </div>
    <div class="table-card" style="overflow-x:auto;margin-bottom:20px">
      <table class="dtable">
        <thead><tr>
          <th>Namespace</th><th>Name</th><th>Schedule</th><th>Status</th>
          <th>Active</th><th>Last Run</th><th>Concurrency</th><th>Age</th>
        </tr></thead>
        <tbody id="cronBody">
          ${crons.length === 0 ? emptyState("No cron jobs found") : crons.map(c => `
            <tr class="${c.suspend ? "row-warn" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(c.namespace)}</span></td>
              <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(c.name)}</span></td>
              <td><code style="font-size:12px;background:#f1f5f9;padding:2px 6px;border-radius:4px;color:#334155">${esc(c.schedule)}</code></td>
              <td>${c.suspend ? badge("Suspended","yellow") : badge("Active","green")}</td>
              <td style="font-size:12px;color:#475569">${c.active > 0 ? badge(c.active + " running","blue") : '<span style="color:#cbd5e1">0</span>'}</td>
              <td style="font-size:11px;color:#94a3b8">${c.last_schedule_age_seconds != null ? fmt.age(c.last_schedule_age_seconds) + " ago" : "—"}</td>
              <td style="font-size:11px;color:#64748b">${esc(c.concurrency_policy || "—")}</td>
              <td style="font-size:11px;color:#94a3b8">${fmt.age(c.age_seconds)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <div style="font-size:12px;font-weight:600;color:#334155;margin-bottom:10px">Recent Jobs</div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Namespace</th><th>Name</th><th>CronJob</th><th>Status</th>
          <th>Succeeded</th><th>Failed</th><th>Duration</th><th>Age</th>
        </tr></thead>
        <tbody>
          ${jobs.length === 0 ? emptyState("No jobs found") : jobs.slice(0, 50).map(j => `
            <tr class="${j.failed_status ? "row-bad" : !j.complete && !j.active ? "row-warn" : ""}">
              <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(j.namespace)}</span></td>
              <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(j.name)}</span></td>
              <td style="font-size:11px;color:#64748b">${j.owner ? esc(j.owner) : '<span style="color:#e2e8f0">—</span>'}</td>
              <td>${j.failed_status ? badge("Failed","red") : j.complete ? badge("Complete","green") : j.active ? badge("Running","blue") : badge("Pending","yellow")}</td>
              <td style="font-size:12px;color:#059669;font-weight:500">${j.succeeded} / ${j.completions}</td>
              <td style="font-size:12px;color:${j.failed_pods > 0 ? "#dc2626" : "#cbd5e1"}">${j.failed_pods}</td>
              <td style="font-size:11px;color:#94a3b8">${j.duration_seconds != null ? fmt.age(j.duration_seconds) : j.active ? badge("In progress","blue") : "—"}</td>
              <td style="font-size:11px;color:#94a3b8">${fmt.age(j.age_seconds)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Services ──────────────────────────────────────────────────────────
async function renderServices() {
  const params = state.namespace ? `?namespace=${encodeURIComponent(state.namespace)}` : "";
  const svcs = await api(`/api/clusters/${state.selected}/services${params}`);

  const typeColor = { ClusterIP: "slate", NodePort: "blue", LoadBalancer: "green", ExternalName: "purple" };

  document.getElementById("content").innerHTML = `
    <div class="filter-bar">
      ${nsFilterHTML()}
      ${searchInput("Search services…", "svcBody")}
      <span style="margin-left:auto;font-size:12px;color:#94a3b8">${svcs.length} services</span>
    </div>
    <div class="table-card" style="overflow-x:auto">
      <table class="dtable">
        <thead><tr>
          <th>Namespace</th><th>Name</th><th>Type</th><th>Cluster IP</th>
          <th>External IP</th><th>Ports</th><th>Age</th>
        </tr></thead>
        <tbody id="svcBody">
          ${svcs.length === 0 ? emptyState("No services found") : svcs.map(s => {
            const ext = s.load_balancer_ip || (s.external_ips || []).join(", ") || "—";
            const ports = (s.ports || []).map(p =>
              `<span style="font-size:11px;background:#f1f5f9;padding:1px 5px;border-radius:3px;white-space:nowrap">${p.port}${p.node_port ? ":" + p.node_port : ""}/${p.protocol}</span>`
            ).join(" ");
            return `
              <tr>
                <td><span style="font-family:monospace;font-size:11px;color:#64748b">${esc(s.namespace)}</span></td>
                <td><span style="font-family:monospace;font-size:12px;font-weight:500;color:#1e293b">${esc(s.name)}</span></td>
                <td>${badge(s.type, typeColor[s.type] || "slate")}</td>
                <td style="font-family:monospace;font-size:11px;color:#64748b">${esc(s.cluster_ip || "—")}</td>
                <td style="font-family:monospace;font-size:11px;color:${ext !== "—" ? "#059669" : "#e2e8f0"}">${esc(ext)}</td>
                <td>${ports || '<span style="color:#e2e8f0">—</span>'}</td>
                <td style="font-size:11px;color:#94a3b8">${fmt.age(s.age_seconds)}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Describe panel ────────────────────────────────────────────────────
const _dc = {
  kvRow: (k, v) => `<tr><td style="color:#64748b;font-size:12px;padding:5px 12px 5px 0;white-space:nowrap;vertical-align:top;font-weight:500">${k}</td><td style="font-size:12px;color:#1e293b;padding:5px 0;word-break:break-all">${v}</td></tr>`,
  section: (title, body) => `<div style="margin-bottom:22px"><p style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #f1f5f9">${title}</p>${body}</div>`,
  events: evs => evs.length ? evs.map(e => `
    <div style="padding:7px 0;border-bottom:1px solid #f8fafc">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${badge(e.reason, e.type === "Warning" ? "yellow" : "slate")}
        <span style="font-size:11px;color:#94a3b8">${fmt.age(e.age_seconds)} ago</span>
        <span style="font-size:10px;color:#cbd5e1">×${e.count}</span>
      </div>
      <p style="font-size:12px;color:#475569;margin-top:3px;line-height:1.5">${esc(e.message || "")}</p>
    </div>`).join("") : `<p style="color:#94a3b8;font-size:12px">No recent events.</p>`,
};

function openDescribe(type, ...args) {
  const overlay = document.getElementById("describeOverlay");
  const panel   = document.getElementById("describePanel");
  overlay.classList.remove("hidden");
  panel.style.transform = "translateX(0)";
  document.getElementById("describeContent").innerHTML =
    `<div style="display:flex;justify-content:center;padding:60px"><span class="spinner" style="width:20px;height:20px;border-width:3px"></span></div>`;

  let url, title, subtitle;
  if (type === "pod") {
    const [ns, name] = args;
    url = `/api/clusters/${state.selected}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/describe`;
    title = name; subtitle = `Pod · ${ns}`;
  } else if (type === "node") {
    const [name] = args;
    url = `/api/clusters/${state.selected}/nodes/${encodeURIComponent(name)}/describe`;
    title = name; subtitle = "Node";
  } else if (type === "workload") {
    const [ns, kind, name] = args;
    url = `/api/clusters/${state.selected}/workloads/${encodeURIComponent(ns)}/${kind.toLowerCase()}/${encodeURIComponent(name)}/describe`;
    title = name; subtitle = `${kind} · ${ns}`;
  }

  document.getElementById("describeTitle").textContent = title;
  document.getElementById("describeSubtitle").textContent = subtitle;

  api(url).then(d => {
    const html =
      type === "pod"      ? _renderPodDescribe(d) :
      type === "node"     ? _renderNodeDescribe(d) :
      type === "workload" ? _renderWorkloadDescribe(d) : "";
    document.getElementById("describeContent").innerHTML = html || `<p style="color:#94a3b8">No data.</p>`;
  }).catch(e => {
    document.getElementById("describeContent").innerHTML =
      `<div style="color:#dc2626;font-size:13px">Error: ${esc(e.message)}</div>`;
  });
}

function closeDescribe() {
  document.getElementById("describeOverlay").classList.add("hidden");
  document.getElementById("describePanel").style.transform = "translateX(100%)";
}

function _renderPodDescribe(d) {
  if (!d || !d.name) return "";
  const c = _dc;

  const basicTable = `<table style="width:100%">
    ${c.kvRow("Node", esc(d.node || "—"))}
    ${c.kvRow("Pod IP", esc(d.pod_ip || "—"))}
    ${c.kvRow("Host IP", esc(d.host_ip || "—"))}
    ${c.kvRow("Phase", podPhaseBadge(d.phase, d.phase === "Running"))}
    ${c.kvRow("QoS class", esc(d.qos_class || "—"))}
    ${c.kvRow("Service account", esc(d.service_account || "default"))}
    ${c.kvRow("Age", fmt.age(d.age_seconds))}
  </table>`;

  const labels = Object.entries(d.labels || {}).map(([k, v]) =>
    `<span style="font-size:11px;background:#f1f5f9;padding:2px 6px;border-radius:4px;margin:2px;display:inline-block">${esc(k)}=<b>${esc(v)}</b></span>`
  ).join("") || '<span style="color:#94a3b8;font-size:12px">none</span>';

  const containers = (d.containers || []).map(con => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span style="font-family:monospace;font-size:13px;font-weight:600;color:#1e293b">${esc(con.name)}</span>
        ${con.ready ? badge("Ready","green") : badge("Not Ready","red")}
        ${con.restart_count > 0 ? restartBadge(con.restart_count) : ""}
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;word-break:break-all">${esc(con.image)}</div>
      ${con.resources && (con.resources.requests?.cpu || con.resources.limits?.memory) ? `
      <table style="width:100%;margin-bottom:8px">
        ${con.resources.requests?.cpu    ? c.kvRow("CPU request",    esc(con.resources.requests.cpu)) : ""}
        ${con.resources.limits?.cpu      ? c.kvRow("CPU limit",      esc(con.resources.limits.cpu)) : ""}
        ${con.resources.requests?.memory ? c.kvRow("Mem request",    esc(con.resources.requests.memory)) : ""}
        ${con.resources.limits?.memory   ? c.kvRow("Mem limit",      esc(con.resources.limits.memory)) : ""}
      </table>` : ""}
      ${con.ports?.length ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:6px">Ports: ${con.ports.map(p => `${p.container_port}/${p.protocol}`).join(", ")}</div>` : ""}
      ${con.volume_mounts?.length ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Mounts: ${con.volume_mounts.map(vm => `<code style="background:#f8fafc;padding:1px 4px">${esc(vm.mount_path)}</code>`).join(", ")}</div>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button onclick="openLogs('${esc(state.selected)}','${esc(d.namespace)}','${esc(d.name)}','${esc(con.name)}')"
          style="font-size:11px;padding:4px 12px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;color:#475569;font-weight:500">
          📋 Logs
        </button>
        <button onclick="openExec('${esc(state.selected)}','${esc(d.namespace)}','${esc(d.name)}','${esc(con.name)}')"
          style="font-size:11px;padding:4px 12px;background:#dbeafe;border:1px solid #bfdbfe;border-radius:6px;cursor:pointer;color:#1e40af;font-weight:500">
          ⚡ Exec
        </button>
      </div>
    </div>`).join("");

  const volumes = (d.volumes || []).map(v => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #f8fafc">
      <span style="font-family:monospace;font-size:11px;color:#1e293b;min-width:140px;flex-shrink:0">${esc(v.name)}</span>
      ${badge(v.type, v.type === "PVC" ? "indigo" : v.type === "Secret" ? "red" : v.type === "ConfigMap" ? "blue" : "slate")}
      ${v.ref ? `<span style="font-size:11px;color:#64748b">${esc(v.ref)}</span>` : ""}
    </div>`).join("") || `<p style="color:#94a3b8;font-size:12px">No volumes.</p>`;

  return `
    ${c.section("Basic Info", basicTable)}
    ${c.section("Labels", `<div style="line-height:2">${labels}</div>`)}
    ${c.section("Containers", containers)}
    ${c.section("Volumes", volumes)}
    ${c.section("Events", c.events(d.events || []))}
  `;
}

function _renderNodeDescribe(d) {
  if (!d || !d.name) return "";
  const c = _dc;

  const basicTable = `<table style="width:100%">
    ${c.kvRow("Roles",    esc((d.roles || []).join(", ") || "worker"))}
    ${c.kvRow("Internal IP", esc(d.addresses?.InternalIP || "—"))}
    ${c.kvRow("External IP", esc(d.addresses?.ExternalIP || "—"))}
    ${c.kvRow("Hostname",    esc(d.addresses?.Hostname   || "—"))}
    ${c.kvRow("Age",         fmt.age(d.age_seconds))}
  </table>`;

  const sysTable = `<table style="width:100%">
    ${c.kvRow("OS Image",   esc(d.system_info?.os_image           || "—"))}
    ${c.kvRow("Kernel",     esc(d.system_info?.kernel_version     || "—"))}
    ${c.kvRow("Kubelet",    esc(d.system_info?.kubelet_version    || "—"))}
    ${c.kvRow("Runtime",    esc(d.system_info?.container_runtime  || "—"))}
    ${c.kvRow("Arch",       esc(d.system_info?.architecture       || "—"))}
  </table>`;

  const capTable = `<table style="width:100%">
    ${c.kvRow("CPU capacity",       fmt.cores(d.capacity?.cpu_cores))}
    ${c.kvRow("CPU allocatable",    fmt.cores(d.allocatable?.cpu_cores))}
    ${c.kvRow("Mem capacity",       fmt.bytes(d.capacity?.memory_bytes))}
    ${c.kvRow("Mem allocatable",    fmt.bytes(d.allocatable?.memory_bytes))}
    ${c.kvRow("Max pods",           d.capacity?.pods ?? "—")}
  </table>`;

  const conditions = Object.entries(d.conditions || {}).map(([type, cv]) => {
    const ok = cv.status === "True";
    const col = type === "Ready" ? (ok ? "green" : "red") : (ok ? "yellow" : "slate");
    return `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #f8fafc">
      ${badge(type, col)}
      <span style="font-size:11px;color:#64748b">${esc(cv.reason || "")}${cv.message ? " — " + esc(cv.message) : ""}</span>
    </div>`;
  }).join("") || `<p style="color:#94a3b8;font-size:12px">No conditions.</p>`;

  const taints = (d.taints || []).map(t =>
    `<div style="font-size:12px;padding:3px 0">${badge(t.effect,"yellow")} <code style="font-size:11px;color:#475569">${esc(t.key)}${t.value ? "=" + t.value : ""}</code></div>`
  ).join("") || `<p style="color:#94a3b8;font-size:12px">No taints.</p>`;

  return `
    ${c.section("Basic Info", basicTable)}
    ${c.section("System Info", sysTable)}
    ${c.section("Capacity & Allocatable", capTable)}
    ${c.section("Conditions", conditions)}
    ${c.section("Taints", taints)}
    ${c.section("Events", c.events(d.events || []))}
  `;
}

function _renderWorkloadDescribe(d) {
  if (!d || !d.name) return "";
  const c = _dc;

  const notReady = d.status.ready < d.status.replicas;
  const basicTable = `<table style="width:100%">
    ${c.kvRow("Kind",            kindBadge(d.kind))}
    ${c.kvRow("Namespace",       esc(d.namespace))}
    ${c.kvRow("Strategy",        esc(d.strategy || "—"))}
    ${c.kvRow("Service account", esc(d.service_account || "default"))}
    ${c.kvRow("Age",             fmt.age(d.age_seconds))}
    ${c.kvRow("Replicas",        `<span style="font-weight:600;color:${notReady ? "#dc2626" : "#059669"}">${d.status.ready} / ${d.status.replicas} ready</span>`)}
  </table>`;

  const selector = Object.entries(d.selector || {}).map(([k, v]) =>
    `<span style="font-size:11px;background:#f1f5f9;padding:2px 6px;border-radius:4px;margin:2px;display:inline-block">${esc(k)}=<b>${esc(v)}</b></span>`
  ).join("") || '<span style="color:#94a3b8;font-size:12px">none</span>';

  const containers = (d.containers || []).map(con => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:10px">
      <div style="font-family:monospace;font-size:13px;font-weight:600;color:#1e293b;margin-bottom:4px">${esc(con.name)}</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;word-break:break-all">${esc(con.image)}</div>
      ${Object.keys(con.resources?.requests || {}).length || Object.keys(con.resources?.limits || {}).length ? `
      <table style="width:100%">
        ${con.resources?.requests?.cpu    ? c.kvRow("CPU request",  esc(con.resources.requests.cpu)) : ""}
        ${con.resources?.limits?.cpu      ? c.kvRow("CPU limit",    esc(con.resources.limits.cpu)) : ""}
        ${con.resources?.requests?.memory ? c.kvRow("Mem request",  esc(con.resources.requests.memory)) : ""}
        ${con.resources?.limits?.memory   ? c.kvRow("Mem limit",    esc(con.resources.limits.memory)) : ""}
      </table>` : ""}
      ${con.ports?.length ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px">Ports: ${con.ports.map(p => `${p.container_port}/${p.protocol}`).join(", ")}</div>` : ""}
    </div>`).join("");

  const conditions = Object.entries(d.conditions || {}).map(([type, cv]) => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid #f8fafc">
      ${badge(type, cv.status === "True" ? "green" : "red")}
      <span style="font-size:11px;color:#64748b">${esc(cv.reason || "")}${cv.message ? " — " + esc(cv.message) : ""}</span>
    </div>`).join("") || `<p style="color:#94a3b8;font-size:12px">No conditions.</p>`;

  return `
    ${c.section("Basic Info", basicTable)}
    ${c.section("Pod Selector", `<div style="line-height:2">${selector}</div>`)}
    ${c.section("Containers", containers)}
    ${c.section("Conditions", conditions)}
    ${c.section("Events", c.events(d.events || []))}
  `;
}

// ── Logs modal ────────────────────────────────────────────────────────
let _logsCtx = null;

async function openLogs(cluster, ns, pod, container) {
  _logsCtx = { cluster, ns, pod, container };
  document.getElementById("logsModal").classList.remove("hidden");
  document.getElementById("logsTitle").textContent = `${ns}/${pod}${container ? " · " + container : ""}`;
  document.getElementById("logsPrevious").checked = false;
  await _fetchLogs();
}

async function refreshLogs() { await _fetchLogs(); }

async function _fetchLogs() {
  if (!_logsCtx) return;
  const { cluster, ns, pod, container } = _logsCtx;
  document.getElementById("logsContent").textContent = "Loading…";
  try {
    const p = new URLSearchParams({ tail: "300" });
    if (container) p.set("container", container);
    if (document.getElementById("logsPrevious")?.checked) p.set("previous", "true");
    const text = await fetch(`/api/clusters/${encodeURIComponent(cluster)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}/logs?${p}`).then(r => r.text());
    document.getElementById("logsContent").textContent = text || "(no output)";
    const scroll = document.getElementById("logsScroll");
    scroll.scrollTop = scroll.scrollHeight;
  } catch (e) {
    document.getElementById("logsContent").textContent = "Error: " + e.message;
  }
}

function closeLogs() {
  _logsCtx = null;
  document.getElementById("logsModal").classList.add("hidden");
}

// ── Exec terminal ─────────────────────────────────────────────────────
let _execWs   = null;
let _execTerm = null;
let _execFit  = null;

function openExec(cluster, ns, pod, container) {
  document.getElementById("execModal").classList.remove("hidden");
  document.getElementById("execTitle").textContent = `${ns}/${pod}${container ? " · " + container : ""}`;

  if (_execTerm) { _execTerm.dispose(); _execTerm = null; }
  if (_execWs)   { _execWs.close();   _execWs   = null; }

  const el = document.getElementById("execTerminal");
  el.innerHTML = "";

  _execTerm = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "ui-monospace,'Cascadia Code','Fira Code',Menlo,monospace",
    theme: { background: "#0f172a", foreground: "#e2e8f0", cursor: "#60a5fa",
             selectionBackground: "rgba(96,165,250,.3)" },
    scrollback: 5000,
  });
  _execFit = new FitAddon.FitAddon();
  _execTerm.loadAddon(_execFit);
  _execTerm.open(el);
  _execFit.fit();  // measure actual cols/rows before opening WS

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams();
  if (container) q.set("container", container);
  // Pass real terminal dimensions so the backend sets COLUMNS/LINES before
  // exec starts — critical for readline-based programs like rails console.
  q.set("cols", _execTerm.cols);
  q.set("rows", _execTerm.rows);
  const url = `${proto}//${location.host}/ws/clusters/${encodeURIComponent(cluster)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(pod)}/exec?${q}`;

  _execWs = new WebSocket(url);
  _execWs.onopen = () => { _sendResize(); };
  _execWs.onmessage = e => _execTerm.write(e.data);
  _execWs.onclose = () => _execTerm?.writeln("\r\n\x1b[33mConnection closed.\x1b[0m");
  _execWs.onerror = () => _execTerm?.writeln("\r\n\x1b[31mWebSocket error.\x1b[0m");

  _execTerm.onData(d => {
    if (_execWs?.readyState === WebSocket.OPEN) _execWs.send(d);
  });

  _execTerm.onResize(({ cols, rows }) => {
    if (_execWs?.readyState === WebSocket.OPEN)
      _execWs.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  window.addEventListener("resize", _sendResize);
}

function _sendResize() {
  if (!_execFit || !_execTerm) return;
  _execFit.fit();
}

function closeExec() {
  window.removeEventListener("resize", _sendResize);
  if (_execWs)   { _execWs.close();   _execWs   = null; }
  if (_execTerm) { _execTerm.dispose(); _execTerm = null; }
  document.getElementById("execModal").classList.add("hidden");
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
