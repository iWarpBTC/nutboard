/* nutboard dashboard. Browser module; talks to the JSON API under /api behind passkey sign-in. */
import { createPasskey, passkeysSupported, usePasskey } from "/lib/passkey.js";


const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const state = {
  auth: null,
  locked: false,
  unit: null,
  range: "30d",
  seriesMode: "amount",
  units: [],
  data: {},
  charts: new Map(),
  timer: null,
};

// ---------- formatting ----------
const UNIT_INFO = {
  sat: { decimals: 0, symbol: "sat" },
  msat: { decimals: 0, symbol: "msat" },
  usd: { decimals: 2, symbol: "$", prefix: true },
  eur: { decimals: 2, symbol: "€", prefix: true },
};
function unitInfo(unit) {
  return UNIT_INFO[unit] || { decimals: 0, symbol: unit };
}
function fmtAmount(n, unit, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const info = unitInfo(unit || state.unit);
  const value = n / 10 ** info.decimals;
  const compact = opts.compact && Math.abs(value) >= 1_000_000;
  const nf = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: compact ? 2 : info.decimals,
    minimumFractionDigits: compact ? 0 : info.decimals,
    notation: compact ? "compact" : "standard",
  });
  const s = nf.format(value);
  if (opts.bare) return s;
  return info.prefix ? `${info.symbol}${s}` : `${s} ${info.symbol}`;
}
function fmtAxis(n, unit) {
  const info = unitInfo(unit || state.unit);
  const value = n / 10 ** info.decimals;
  const s = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return info.prefix ? `${info.symbol}${s}` : s;
}
const fmtInt = (n) => (n === null || n === undefined ? "–" : new Intl.NumberFormat().format(n));
const fmtPct = (num, den) => (den > 0 ? `${Math.round((num / den) * 100)}%` : "–");
const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
function fmtAgo(d) {
  if (!d) return "–";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function bucketLabel(iso, bin) {
  const d = new Date(iso);
  if (bin === "1 hour" || bin === "6 hours") {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (bin === null) return d.toLocaleString(undefined, { month: "short", year: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const KIND_LABEL = { mint: "Minted", melt: "Melted", swap: "Swapped" };

// ---------- theme & chart chrome ----------
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function palette() {
  return {
    mint: cssVar("--series-mint"),
    melt: cssVar("--series-melt"),
    swap: cssVar("--series-swap"),
    text: cssVar("--text"),
    text2: cssVar("--text-2"),
    muted: cssVar("--muted"),
    grid: cssVar("--grid"),
    axis: cssVar("--axis"),
    surface: cssVar("--surface"),
    border: cssVar("--border"),
  };
}
function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
function applyChartDefaults() {
  const p = palette();
  Chart.defaults.font.family = cssVar("--font") || "system-ui, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = p.text2;
  Chart.defaults.borderColor = p.grid;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.plugins.tooltip.backgroundColor = p.surface;
  Chart.defaults.plugins.tooltip.titleColor = p.text;
  Chart.defaults.plugins.tooltip.bodyColor = p.text2;
  Chart.defaults.plugins.tooltip.borderColor = p.axis;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.usePointStyle = true;
  Chart.defaults.plugins.tooltip.boxWidth = 8;
  Chart.defaults.plugins.tooltip.boxHeight = 8;
}
function baseScales(p, { unit = true, yWidth = null, xTicks = true } = {}) {
  return {
    x: {
      grid: { display: false },
      border: { color: p.axis },
      ticks: { display: xTicks, maxTicksLimit: 8, maxRotation: 0, autoSkip: true, color: p.muted },
    },
    y: {
      beginAtZero: true,
      grid: { color: p.grid, drawTicks: false },
      border: { display: false, dash: [] },
      ticks: {
        maxTicksLimit: 5,
        color: p.muted,
        callback: (v) => (unit ? fmtAxis(v) : new Intl.NumberFormat(undefined, { notation: "compact" }).format(v)),
        padding: 6,
      },
      afterFit: yWidth ? (scale) => { scale.width = yWidth; } : undefined,
    },
  };
}
function mountChart(id, config) {
  const old = state.charts.get(id);
  if (old) old.destroy();
  const canvas = typeof id === "string" ? document.getElementById(id) : id;
  if (!canvas) return null;
  const chart = new Chart(canvas, config);
  state.charts.set(id, chart);
  return chart;
}
function setTheme(theme) {
  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("nutboard-theme", theme); } catch {}
  } else {
    document.documentElement.removeAttribute("data-theme");
    try { localStorage.removeItem("nutboard-theme"); } catch {}
  }
  renderAll();
}
function currentThemeIsDark() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// ---------- data ----------
async function fetchJson(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 401 && !path.startsWith("/api/auth/")) showAuth({ registered: true, authenticated: false });
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.code = body.code;
    throw err;
  }
  return body;
}

/** JSON call with a body (sign-in endpoints); same-origin cookies travel automatically. */
async function post(path, body = {}, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(method === "DELETE" ? {} : { "content-type": "application/json" }) },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}
function showError(msg) {
  const el = $("#error-banner");
  el.textContent = msg;
  el.classList.toggle("show", Boolean(msg));
}

async function loadAll() {
  if (state.locked) return;
  const main = $("#main");
  main.classList.add("loading");
  try {
    const health = await fetchJson("/api/health");
    state.data.health = health;
    const units = await fetchJson("/api/units");
    state.units = units;
    if (!state.unit || !units.includes(state.unit)) state.unit = units.includes("sat") ? "sat" : units[0];
    const unit = state.unit;
    const [overview, timeseries, fees, keysets, denominations, balanceLog, hourly, activity, audit] = await Promise.all([
      fetchJson("/api/overview", { unit }),
      fetchJson("/api/timeseries", { unit, range: state.range }),
      fetchJson("/api/fees", { unit, range: state.range }),
      fetchJson("/api/keysets"),
      fetchJson("/api/denominations", { unit }),
      fetchJson("/api/balance-log", { unit, range: state.range === "24h" || state.range === "7d" ? "30d" : state.range }),
      fetchJson("/api/hourly", { unit }),
      fetchJson("/api/activity", { unit, limit: 40 }),
      fetchJson("/api/audit", { unit }),
    ]);
    Object.assign(state.data, { overview, timeseries, keysets, denominations, balanceLog, hourly, activity, audit, fees });
    showError("");
    renderAll();
    loadPasskeys();
  } catch (err) {
    if (!state.locked) showError(`Could not load statistics: ${err.message}`);
  } finally {
    main.classList.remove("loading");
  }
}

// ---------- rendering ----------
function renderAll() {
  if (!state.data.overview) return;
  applyChartDefaults();
  renderStatus();
  renderUnitSelect();
  renderHero();
  renderWindowTable();
  renderSmallMultiples();
  renderFees();
  renderBalanceChart();
  renderHourly();
  renderDenominations();
  renderQuoteStates();
  renderChecks();
  renderKeysets();
  renderActivity();
  renderFooter();
}

function renderStatus() {
  const h = state.data.health;
  const bar = $("#status-bar");
  $("#mint-name").textContent = h.mintName || "nutboard";
  document.title = `${h.mintName || "nutboard"} · nutboard`;
  const pills = [];
  pills.push(`<span class="pill ${h.readOnly ? "ok" : "fail"}"><span class="dot"></span>${h.readOnly ? "session read-only" : "SESSION NOT READ-ONLY"}</span>`);
  pills.push(`<span class="pill ${h.connection.roleCanWrite || h.connection.superuser ? "warn" : "ok"}"><span class="dot"></span>role ${esc(h.connection.user)}${h.connection.superuser ? " (superuser!)" : h.connection.roleCanWrite ? " (has write privileges)" : " (select-only)"}</span>`);
  pills.push(`<span class="pill detail"><span class="dot"></span>${esc(h.connection.database)} · PostgreSQL ${esc(h.connection.serverVersion)}</span>`);
  pills.push(`<span class="pill detail"><span class="dot"></span>Nutshell db v${h.nutshellDbVersion ?? "?"}</span>`);
    const tz = h.timeZone;
    pills.push(
      `<span class="pill ${tz?.hint ? "warn" : ""}" title="${esc(tz?.hint || (tz?.newestRow ? `newest ledger row ${tz.newestRow} mint local time` : ""))}"><span class="dot"></span>mint time zone ${esc(h.mintTz)}${
        tz?.newestRow ? ` · newest row ${esc(fmtAgo(new Date(Date.now() - (tz.ageConfiguredSeconds ?? 0) * 1000)))}` : ""
      }</span>`,
    );
    if (tz?.hint) pills.push(`<span class="pill warn"><span class="dot"></span>${esc(tz.hint)}</span>`);
  pills.push(`<span class="pill detail"><span class="dot"></span>db ${h.dbLatencyMs} ms · cache ${h.cacheTtlSeconds}s</span>`);
  bar.innerHTML = pills.join("");
}

function renderUnitSelect() {
  const sel = $("#unit-select");
  const current = sel.value;
  sel.innerHTML = state.units.map((u) => `<option value="${esc(u)}">${esc(u)}</option>`).join("");
  sel.value = state.unit;
  sel.parentElement.style.display = state.units.length > 1 ? "" : "none";
  if (current !== state.unit) sel.value = state.unit;
}

function renderHero() {
  const o = state.data.overview;
  const L = o.liabilities;
  const unit = o.unit;
  const hero = $("#hero");
  hero.innerHTML = `
    <div class="label">Outstanding ecash (issued − redeemed)</div>
    <div class="value">${esc(fmtAmount(L.outstanding, unit, { bare: true }))}<span class="unit">${esc(unitInfo(unit).symbol === "$" || unitInfo(unit).symbol === "€" ? unit : unitInfo(unit).symbol)}</span></div>
    <div class="sub">${esc(fmtInt(L.issuedCount))} notes signed, ${esc(fmtInt(L.redeemedCount))} spent, ${esc(fmtInt(L.issuedCount - L.redeemedCount))} unspent · ${esc(fmtInt(L.activeKeysets))}/${esc(fmtInt(L.keysets))} keysets active</div>
    <div class="sub counter-line">${L.keysetBalance === null ? "" : `mint's own balance counter: <strong class="num">${esc(fmtAmount(L.keysetBalance, unit))}</strong> ${L.keysetBalance === L.outstanding - L.pending ? '<span class="pill ok inline-pill"><span class="dot"></span>matches ledger</span>' : '<span class="pill fail inline-pill"><span class="dot"></span>differs from ledger</span>'}`}</div>`;

  const tiles = [];
  const tile = (label, value, sub = "", cls = "") =>
    `<div class="tile ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  const la = o.lastActivity;
  const agoOrNever = (d) => (d ? fmtAgo(d) : "never");
  tiles.push(
    tile(
      "Last operation",
      la.any ? `<span title="${esc(fmtDate(la.any))}">${esc(fmtAgo(la.any))}</span>` : "never",
      `mint ${esc(agoOrNever(la.mint))} · melt ${esc(agoOrNever(la.melt))} · swap ${esc(agoOrNever(la.swap))}`,
      la.any && Date.now() - new Date(la.any).getTime() > 86_400_000 ? "bad" : "",
    ),
  );
  tiles.push(tile("Issued (all time)", esc(fmtAmount(L.issued, unit, { compact: true })), `${esc(fmtInt(L.issuedCount))} blind signatures`));
  tiles.push(tile("Redeemed (all time)", esc(fmtAmount(L.redeemed, unit, { compact: true })), `${esc(fmtInt(L.redeemedCount))} proofs spent`));
  tiles.push(tile("Pending proofs", esc(fmtAmount(L.pending, unit, { compact: true })), `${esc(fmtInt(L.pendingCount))} proofs in flight`));
  tiles.push(tile("Input fees collected", L.feesPaid === null ? "–" : esc(fmtAmount(L.feesPaid, unit, { compact: true })), "keysets.fees_paid"));
  tiles.push(tile("Lightning fees paid", esc(fmtAmount(o.melt.all.fee_paid, unit, { compact: true })), `of ${esc(fmtAmount(o.melt.all.fee_reserve, unit, { compact: true }))} reserved`));
  if (o.lastBalanceLog) {
    const b = o.lastBalanceLog;
    const reserve = b.backendBalance - b.keysetBalance;
    tiles.push(tile("Backend reserve", esc(fmtAmount(reserve, unit, { compact: true })), `backend ${esc(fmtAmount(b.backendBalance, unit, { compact: true }))} · logged ${esc(fmtAgo(b.time))}`, reserve < 0 ? "bad" : ""));
  } else {
    tiles.push(tile("Backend reserve", "–", "no balance_log entries"));
  }
  tiles.push(tile("Unsigned outputs", esc(fmtInt(L.unsignedPromises)), "stored blinded messages without a signature"));
  $("#tiles").innerHTML = tiles.join("");
}

function renderWindowTable() {
  const o = state.data.overview;
  const unit = o.unit;
  const W = o.windows;
  const cell = (amount, count, countLabel) =>
    `<td class="num"><span title="${esc(fmtAmount(amount, unit))}">${esc(fmtAmount(amount, unit, { compact: true }))}</span><span class="cell-sub">${esc(fmtInt(count))} ${countLabel}</span></td>`;
  const row = (swatch, label, hint, cells) =>
    `<tr><td><div class="row-label"><span class="swatch ${swatch}"></span><div>${label}<span class="cell-sub">${hint}</span></div></div></td>${cells}</tr>`;
  const rows = [];
  rows.push(row("mint", "Minted", "Lightning paid in, ecash issued", W.map((w) => cell(o.mint[w.key].amount, o.mint[w.key].count, "quotes")).join("")));
  rows.push(row("melt", "Melted", "ecash redeemed, Lightning paid out", W.map((w) => cell(o.melt[w.key].amount, o.melt[w.key].count, "quotes")).join("")));
  rows.push(row("swap", "Swapped", "ecash exchanged for new ecash (≈ operations)", W.map((w) => cell(o.signatures[w.key].swap_amount, o.signatures[w.key].swap_ops, "swaps ≈")).join("")));
  rows.push(row("neutral", "Blind signatures", "all outputs signed (mint + swap + melt change)", W.map((w) => cell(o.signatures[w.key].amount, o.signatures[w.key].count, "outputs")).join("")));
  rows.push(row("neutral", "Proofs spent", "inputs consumed by swaps and melts", W.map((w) => cell(o.spent[w.key].amount, o.spent[w.key].count, "proofs")).join("")));
  if (o.signatures.all.legacy_count > 0 || o.spent.all.legacy_count > 0) {
    rows.push(row("neutral", "Legacy rows", `outputs / spent proofs older than the quote links (before ${esc(o.legacy.mintLinkSince || o.legacy.spentLinkSince || "?")} mint time); origin unknown, not counted as swaps`,
      W.map((w) => `<td class="num">${esc(fmtAmount(o.signatures[w.key].legacy_amount, unit, { compact: true }))}<span class="cell-sub">${esc(fmtInt(o.signatures[w.key].legacy_count))} outputs · ${esc(fmtInt(o.spent[w.key].legacy_count))} proofs</span></td>`).join("")));
  }
  rows.push(
    `<tr><td><div class="row-label"><span class="swatch neutral"></span><div>Mint requests<span class="cell-sub">quotes created → paid and issued</span></div></div></td>` +
      W.map((w) => {
        const r = o.mintRequests[w.key];
        return `<td class="num">${esc(fmtInt(r.count))}<span class="cell-sub">${esc(fmtPct(r.issued_count, r.count))} issued · ${esc(fmtInt(r.unpaid_count))} unpaid</span></td>`;
      }).join("") +
      `</tr>`,
  );
  rows.push(
    `<tr><td><div class="row-label"><span class="swatch neutral"></span><div>Lightning fees paid<span class="cell-sub">on melts, of the reserve collected</span></div></div></td>` +
      W.map((w) => {
        const m = o.melt[w.key];
        return `<td class="num">${esc(fmtAmount(m.fee_paid, unit))}<span class="cell-sub">reserved ${esc(fmtAmount(m.fee_reserve, unit))}</span></td>`;
      }).join("") +
      `</tr>`,
  );
  rows.push(
    `<tr><td><div class="row-label"><span class="swatch neutral"></span><div>Average mint / melt<span class="cell-sub">largest in window</span></div></div></td>` +
      W.map((w) => `<td class="num">${esc(fmtAmount(Math.round(o.mint[w.key].avg), unit))} / ${esc(fmtAmount(Math.round(o.melt[w.key].avg), unit))}<span class="cell-sub">max ${esc(fmtAmount(o.mint[w.key].max, unit))} / ${esc(fmtAmount(o.melt[w.key].max, unit))}</span></td>`).join("") +
      `</tr>`,
  );
  $("#window-table").innerHTML =
    `<thead><tr><th></th>${W.map((w) => `<th class="num">${esc(w.label)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`;
}

function renderSmallMultiples() {
  const ts = state.data.timeseries;
  const p = palette();
  const unit = ts.unit;
  const mode = state.seriesMode;
  const labels = ts.buckets.map((b) => bucketLabel(b, ts.bin));
  const container = $("#small-multiples");
  const defs = [
    { key: "mint", name: "Minted", color: p.mint, countLabel: "quotes" },
    { key: "melt", name: "Melted", color: p.melt, countLabel: "quotes" },
    { key: "swap", name: "Swapped", color: p.swap, countLabel: "swaps ≈" },
  ];
  // Rebuild rows (destroying old charts) so canvases are fresh.
  for (const d of defs) {
    const old = state.charts.get(`sm-${d.key}`);
    if (old) old.destroy();
  }
  container.innerHTML = defs
    .map((d) => {
      const rows = ts[d.key];
      const total = rows.reduce((s, r) => s + (mode === "amount" ? r.amount : r.count), 0);
      const count = rows.reduce((s, r) => s + r.count, 0);
      const amount = rows.reduce((s, r) => s + r.amount, 0);
      return `<div class="sm-row">
        <div class="sm-meta">
          <div class="name"><span class="swatch ${d.key}"></span>${d.name}</div>
          <div class="total">${mode === "amount" ? esc(fmtAmount(total, unit, { compact: true })) : esc(fmtInt(total))}</div>
          <div class="sub">${mode === "amount" ? `${esc(fmtInt(count))} ${d.countLabel}` : esc(fmtAmount(amount, unit, { compact: true }))} in range</div>
        </div>
        <div class="sm-chart"><canvas id="sm-${d.key}"></canvas></div>
      </div>`;
    })
    .join("");
  defs.forEach((d, i) => {
    const rows = ts[d.key];
    const data = rows.map((r) => (mode === "amount" ? r.amount : r.count));
    const scales = baseScales(p, { unit: mode === "amount", yWidth: 56, xTicks: i === defs.length - 1 });
    scales.y.ticks.maxTicksLimit = 3;
    mountChart(`sm-${d.key}`, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: d.name,
          data,
          borderColor: d.color,
          backgroundColor: withAlpha(d.color, 0.1),
          fill: true,
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHitRadius: 14,
          pointHoverBackgroundColor: d.color,
          pointHoverBorderColor: p.surface,
          pointHoverBorderWidth: 2,
          borderJoinStyle: "round",
          borderCapStyle: "round",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => fmtDate(ts.buckets[items[0].dataIndex]),
              label: (item) => {
                const r = rows[item.dataIndex];
                return ` ${d.name}: ${fmtAmount(r.amount, unit)} · ${fmtInt(r.count)} ${d.countLabel}${r.fee !== undefined ? ` · LN fees ${fmtAmount(r.fee, unit)}` : ""}`;
              },
            },
          },
        },
        scales,
      },
    });
  });

  $("#timeseries-table").innerHTML = `<table><thead><tr><th>Bucket</th><th class="num">Minted</th><th class="num">Mints</th><th class="num">Melted</th><th class="num">Melts</th><th class="num">LN fees</th><th class="num">Swapped</th><th class="num">Swaps ≈</th></tr></thead><tbody>${ts.buckets
    .map((b, i) => `<tr><td>${esc(fmtDate(b))}</td><td class="num">${esc(fmtAmount(ts.mint[i].amount, unit))}</td><td class="num">${ts.mint[i].count}</td><td class="num">${esc(fmtAmount(ts.melt[i].amount, unit))}</td><td class="num">${ts.melt[i].count}</td><td class="num">${esc(fmtAmount(ts.melt[i].fee ?? 0, unit))}</td><td class="num">${esc(fmtAmount(ts.swap[i].amount, unit))}</td><td class="num">${ts.swap[i].count}</td></tr>`)
    .join("")}</tbody></table>`;
}

function fmtPctFine(ratio) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "–";
  const p = ratio * 100;
  const digits = p >= 10 ? 1 : p >= 1 ? 2 : 3;
  return `${p.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
const ppm = (ratio) => (ratio === null || ratio === undefined || !Number.isFinite(ratio) ? "" : `${fmtInt(Math.round(ratio * 1_000_000))} ppm`);

function bucketLabelFor(mag, unit) {
  const lo = 10 ** mag;
  const hi = 10 ** (mag + 1) - 1;
  return mag >= 6 ? `${fmtAmount(lo, unit, { bare: true })}+` : `${fmtAmount(lo, unit, { bare: true })} – ${fmtAmount(hi, unit, { bare: true })}`;
}

function renderFees() {
  const f = state.data.fees;
  const unit = f.unit;
  const p = palette();
  const rows = f.buckets;
  const ratio = (num, den) => (den > 0 && num !== null && num !== undefined ? num / den : null);
  const lnPct = (b) => ratio(b.lnFee, b.amount);
  const mintPct = (b) => ratio(b.mintFee, b.mintFeeBase);
  mountChart("fees-chart", {
    type: "bar",
    data: {
      labels: rows.map((b) => bucketLabelFor(b.magnitude, unit)),
      datasets: [
        { label: "LN routing fee, % of amount", data: rows.map((b) => (lnPct(b) ?? 0) * 100), backgroundColor: p.mint, hoverBackgroundColor: p.mint, borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 24 },
        { label: "Mint input fee, % of amount", data: rows.map((b) => (mintPct(b) ?? 0) * 100), backgroundColor: p.melt, hoverBackgroundColor: p.melt, borderRadius: 4, borderSkipped: "bottom", maxBarThickness: 24 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      categoryPercentage: 0.7,
      barPercentage: 0.9,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label} ${unitInfo(unit).symbol} · ${fmtInt(rows[items[0].dataIndex].count)} payments`,
            label: (item) => ` ${item.dataset.label}: ${fmtPctFine(item.raw / 100)}`,
          },
        },
      },
      scales: (() => {
        const s = baseScales(p, { unit: false });
        s.y.ticks.callback = (v) => `${v}%`;
        s.x.ticks.maxTicksLimit = 12;
        return s;
      })(),
    },
  });
  const row = (b, cls = "") => {
    const label = b.magnitude === null ? "All sizes" : `${bucketLabelFor(b.magnitude, unit)} ${esc(unitInfo(unit).symbol)}`;
    const ln = lnPct(b);
    const mint = mintPct(b);
    return `<tr class="${cls}">
      <td>${label}</td>
      <td class="num">${fmtInt(b.count)}<span class="cell-sub">${fmtInt(b.freeCount)} fee-free</span></td>
      <td class="num">${esc(fmtAmount(b.amount, unit))}</td>
      <td class="num">${esc(fmtAmount(b.lnFee, unit))}<span class="cell-sub">max ${esc(fmtAmount(b.maxLnFee, unit))}</span></td>
      <td class="num">${esc(fmtPctFine(ln))}<span class="cell-sub">${esc(ppm(ln))}</span></td>
      <td class="num">${esc(fmtPctFine(b.medianLnRatio))}<span class="cell-sub">${esc(ppm(b.medianLnRatio))}</span></td>
      <td class="num">${b.mintFee === null ? "–" : esc(fmtAmount(b.mintFee, unit))}${b.linkedCount < b.count ? `<span class="cell-sub">${fmtInt(b.linkedCount)} of ${fmtInt(b.count)} linked</span>` : ""}</td>
      <td class="num">${esc(fmtPctFine(mint))}<span class="cell-sub">${esc(ppm(mint))}</span></td>
      <td class="num">${esc(fmtAmount(b.feeReserve, unit))}<span class="cell-sub">${esc(fmtPctFine(ratio(b.feeReserve, b.amount)))}</span></td>
    </tr>`;
  };
  $("#fees-table").innerHTML = rows.length
    ? `<thead><tr><th>Payment size</th><th class="num">Payments</th><th class="num">Volume</th><th class="num">LN fee paid</th><th class="num">LN fee %</th><th class="num">Median LN fee %</th><th class="num">Mint fee</th><th class="num">Mint fee %</th><th class="num">Reserve asked</th></tr></thead>
       <tbody>${rows.map((b) => row(b)).join("")}${f.total ? row(f.total, "total") : ""}</tbody>`
    : `<tbody><tr><td class="empty">no paid melts in this range</td></tr></tbody>`;
}

function renderBalanceChart() {
  const rows = state.data.balanceLog;
  const p = palette();
  const unit = state.unit;
  const box = $("#balance-chart-box");
  const old = state.charts.get("balance-chart");
  if (old) old.destroy();
  if (!rows.length) {
    box.innerHTML = `<div class="empty">No balance_log entries for ${esc(unit)} in this range. Nutshell writes them when it reconciles its Lightning backend balance.</div>`;
    $("#balance-table").innerHTML = "";
    return;
  }
  box.innerHTML = `<canvas id="balance-chart"></canvas>`;
  const labels = rows.map((r) => new Date(r.time).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const lineBase = (color) => ({
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    tension: 0.2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 14,
    pointHoverBorderColor: p.surface,
    pointHoverBorderWidth: 2,
    fill: false,
  });
  mountChart("balance-chart", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Lightning backend balance", data: rows.map((r) => r.backendBalance), ...lineBase(p.mint) },
        { label: "Outstanding ecash (keyset balance)", data: rows.map((r) => r.keysetBalance), ...lineBase(p.melt) },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            title: (items) => fmtDate(rows[items[0].dataIndex].time),
            label: (item) => ` ${item.dataset.label}: ${fmtAmount(item.raw, unit)}`,
            afterBody: (items) => {
              const r = rows[items[0].dataIndex];
              return [`reserve: ${fmtAmount(r.backendBalance - r.keysetBalance, unit)}`, `fees collected: ${fmtAmount(r.keysetFeesPaid, unit)}`];
            },
          },
        },
      },
      scales: baseScales(p),
    },
  });
  $("#balance-table").innerHTML = `<table><thead><tr><th>Logged</th><th class="num">Backend</th><th class="num">Keyset balance</th><th class="num">Reserve</th><th class="num">Fees</th></tr></thead><tbody>${rows
    .slice()
    .reverse()
    .map((r) => `<tr><td>${esc(fmtDate(r.time))}</td><td class="num">${esc(fmtAmount(r.backendBalance, unit))}</td><td class="num">${esc(fmtAmount(r.keysetBalance, unit))}</td><td class="num">${esc(fmtAmount(r.backendBalance - r.keysetBalance, unit))}</td><td class="num">${esc(fmtAmount(r.keysetFeesPaid, unit))}</td></tr>`)
    .join("")}</tbody></table>`;
}

function renderHourly() {
  const rows = state.data.hourly;
  const p = palette();
  $("#hourly-hint").textContent = `last 30 days, mint local time (${state.data.health.mintTz})`;
  const bar = (label, color, key) => ({
    label,
    data: rows.map((r) => r[key]),
    backgroundColor: color,
    hoverBackgroundColor: color,
    borderRadius: 4,
    borderSkipped: "bottom",
    maxBarThickness: 24,
  });
  mountChart("hourly-chart", {
    type: "bar",
    data: {
      labels: rows.map((r) => String(r.hour).padStart(2, "0")),
      datasets: [bar("Mints", p.mint, "mints"), bar("Melts", p.melt, "melts"), bar("Swaps ≈", p.swap, "swaps")],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      categoryPercentage: 0.8,
      barPercentage: 0.85,
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { title: (items) => `${items[0].label}:00 – ${items[0].label}:59`, label: (item) => ` ${item.dataset.label}: ${fmtInt(item.raw)}` } },
      },
      scales: (() => {
        const s = baseScales(p, { unit: false });
        s.x.ticks.maxTicksLimit = 24;
        return s;
      })(),
    },
  });
  $("#hourly-table").innerHTML = `<table><thead><tr><th>Hour</th><th class="num">Mints</th><th class="num">Melts</th><th class="num">Swaps ≈</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${String(r.hour).padStart(2, "0")}:00</td><td class="num">${r.mints}</td><td class="num">${r.melts}</td><td class="num">${r.swaps}</td></tr>`)
    .join("")}</tbody></table>`;
}

function renderDenominations() {
  const rows = state.data.denominations.filter((r) => r.issued > 0 || r.spent > 0);
  const p = palette();
  const unit = state.unit;
  mountChart("denom-chart", {
    type: "bar",
    data: {
      labels: rows.map((r) => fmtAmount(r.amount, unit, { bare: true })),
      datasets: [{
        label: "Outstanding notes",
        data: rows.map((r) => r.outstanding),
        backgroundColor: p.mint,
        hoverBackgroundColor: p.mint,
        borderRadius: 4,
        borderSkipped: "bottom",
        maxBarThickness: 24,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${fmtAmount(rows[items[0].dataIndex].amount, unit)} notes`,
            label: (item) => {
              const r = rows[item.dataIndex];
              return [` outstanding: ${fmtInt(r.outstanding)} (${fmtAmount(r.outstanding * r.amount, unit)})`, ` issued ${fmtInt(r.issued)} · spent ${fmtInt(r.spent)} · pending ${fmtInt(r.pending)}`];
            },
          },
        },
      },
      scales: (() => {
        const s = baseScales(p, { unit: false });
        s.x.ticks.maxTicksLimit = 32;
        return s;
      })(),
    },
  });
  $("#denom-table").innerHTML = `<table><thead><tr><th class="num">Amount</th><th class="num">Issued</th><th class="num">Spent</th><th class="num">Pending</th><th class="num">Outstanding</th><th class="num">Value</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td class="num">${esc(fmtAmount(r.amount, unit))}</td><td class="num">${fmtInt(r.issued)}</td><td class="num">${fmtInt(r.spent)}</td><td class="num">${fmtInt(r.pending)}</td><td class="num">${fmtInt(r.outstanding)}</td><td class="num">${esc(fmtAmount(r.outstanding * r.amount, unit))}</td></tr>`)
    .join("")}</tbody></table>`;
}

function renderQuoteStates() {
  const o = state.data.overview;
  const unit = o.unit;
  const block = (title, rows, order) => {
    const sorted = rows.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return `<div><h3 class="block-title">${title} <span class="muted">(${fmtInt(total)})</span></h3><table><thead><tr><th>State</th><th class="num">Quotes</th><th class="num">Amount</th></tr></thead><tbody>${
      sorted.map((r) => `<tr><td>${esc(r.state)}</td><td class="num">${fmtInt(r.count)}<span class="cell-sub">${fmtPct(r.count, total)}</span></td><td class="num">${esc(fmtAmount(r.amount, unit))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">none</td></tr>`
    }</tbody></table></div>`;
  };
  $("#quote-states").innerHTML =
    block("Mint quotes", o.mintStates, ["UNPAID", "PAID", "PENDING", "ISSUED"]) +
    block("Melt quotes", o.meltStates, ["UNPAID", "PENDING", "PAID"]);
}

function recordsTable(records) {
  const cols = Object.keys(records[0]);
  const unit = state.unit;
  const cell = (k, v) => {
    if (v === null || v === undefined) return `<td class="muted">–</td>`;
    if (typeof v === "number") return `<td class="num">${/amount|balance|issued|redeemed|pending|computed|diff|reserve|fee/.test(k) ? esc(fmtAmount(v, unit)) : fmtInt(v)}</td>`;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return `<td>${esc(fmtDate(v))}<span class="cell-sub">${esc(fmtAgo(v))}</span></td>`;
    if (typeof v === "boolean") return `<td>${v ? "yes" : "no"}</td>`;
    return `<td class="mono">${esc(String(v))}</td>`;
  };
  return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c.replaceAll("_", " "))}</th>`).join("")}</tr></thead><tbody>${records
    .map((r) => `<tr>${cols.map((c) => cell(c, r[c])).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function renderChecks() {
  const ICON = { ok: "✓", warn: "!", fail: "✕", info: "i", skip: "–" };
  const LABEL = { ok: "pass", warn: "warning", fail: "FAIL", info: "info", skip: "skipped" };
  $("#checks").innerHTML = state.data.audit
    .map(
      (c) => `<li class="check ${c.status}"><span class="icon" aria-hidden="true">${ICON[c.status]}</span><div>
        <div class="title">${esc(c.title)} <span class="badge">${LABEL[c.status]}</span></div>
        <div class="summary">${esc(c.summary)}</div>
        ${c.records?.length ? `<details${c.status === "warn" || c.status === "fail" ? " open" : ""}><summary class="muted">${c.records.length} record${c.records.length === 1 ? "" : "s"}${c.truncated ? " (first " + c.records.length + ")" : ""}</summary>${recordsTable(c.records)}</details>` : ""}
        ${c.remedy ? `<details><summary class="muted">what this means and how to address it</summary><p class="remedy">${esc(c.remedy)}</p></details>` : ""}
        ${c.details ? `<details><summary class="muted">details</summary><pre>${esc(JSON.stringify(c.details, null, 2))}</pre></details>` : ""}
      </div></li>`,
    )
    .join("");
}

function renderKeysets() {
  const rows = state.data.keysets;
  $("#keysets-table").innerHTML = `<thead><tr><th>Keyset</th><th>Unit</th><th>Fee ppk</th><th>First seen</th><th class="num">Issued</th><th class="num">Redeemed</th><th class="num">Pending</th><th class="num">Balance</th><th class="num">Fees paid</th><th>Ledger</th></tr></thead><tbody>${rows
    .map((k) => {
      const unit = k.unit || state.unit;
      return `<tr>
        <td><span class="mono">${esc(k.id)}</span> ${k.active ? '<span class="badge active">active</span>' : '<span class="badge">inactive</span>'}<span class="cell-sub">${esc(k.version || "")}${k.denominations ? ` · ${k.denominations} denominations` : ""}</span></td>
        <td>${esc(unit)}</td>
        <td class="num">${k.inputFeePpk === null ? "–" : fmtInt(k.inputFeePpk)}</td>
        <td>${esc(fmtDate(k.firstSeen))}</td>
        <td class="num">${esc(fmtAmount(k.issued, unit))}<span class="cell-sub">${fmtInt(k.signedCount)} signed${k.unsignedCount ? ` · ${fmtInt(k.unsignedCount)} unsigned` : ""}</span></td>
        <td class="num">${esc(fmtAmount(k.redeemed, unit))}<span class="cell-sub">${fmtInt(k.spentCount)} proofs</span></td>
        <td class="num">${esc(fmtAmount(k.pending, unit))}<span class="cell-sub">${fmtInt(k.pendingCount)} proofs</span></td>
        <td class="num">${k.balance === null ? "–" : esc(fmtAmount(k.balance, unit))}<span class="cell-sub">ledger ${esc(fmtAmount(k.computedBalance, unit))}</span></td>
        <td class="num">${k.feesPaid === null ? "–" : esc(fmtAmount(k.feesPaid, unit))}</td>
        <td>${k.balanceMatches === null ? '<span class="muted">n/a</span>' : k.balanceMatches ? '<span class="pill ok"><span class="dot"></span>match</span>' : '<span class="pill fail"><span class="dot"></span>mismatch</span>'}</td>
      </tr>`;
    })
    .join("")}</tbody>`;
}

function renderActivity() {
  const rows = state.data.activity;
  const unit = state.unit;
  $("#activity-table").innerHTML = `<thead><tr><th>When</th><th>Operation</th><th class="num">Amount</th><th class="num">Detail</th></tr></thead><tbody>${
    rows
      .map(
        (r) => `<tr><td>${esc(fmtAgo(r.at))}<span class="cell-sub">${esc(fmtDate(r.at))}</span></td>
        <td><span class="kind"><span class="swatch ${r.kind}"></span>${KIND_LABEL[r.kind] || r.kind}</span></td>
        <td class="num">${esc(fmtAmount(r.amount, unit))}</td>
        <td class="num muted">${r.kind === "melt" ? `LN fee ${esc(fmtAmount(r.fee || 0, unit))}` : r.kind === "swap" ? `${fmtInt(r.inputs)} outputs` : ""}</td></tr>`,
      )
      .join("") || `<tr><td colspan="4" class="empty">no activity in the last 30 days</td></tr>`
  }</tbody>`;
}

function renderFooter() {
  const o = state.data.overview;
  const b = state.data.health.build;
  const deployed = b
    ? `nutboard ${esc(b.version)} · commit <span class="mono">${esc(b.commit)}${b.dirty ? "+dirty" : ""}</span>${b.builtAt ? ` · deployed ${esc(fmtDate(b.builtAt))}` : ""}<br>`
    : "";
  $("#footer").innerHTML = `${deployed}Statistics generated ${esc(fmtDate(o.generatedAt))} from read-only queries. Swap counts are approximate: Nutshell does not record a swap id, so outputs stored within the same second are counted as one swap. Blind signatures mean the mint cannot see who holds which notes; everything here is derived from issued and redeemed amounts only.`;
}

// ---------- events ----------
$("#unit-select").addEventListener("change", (e) => {
  state.unit = e.target.value;
  loadAll();
});
$("#range-select").addEventListener("change", (e) => {
  state.range = e.target.value;
  loadAll();
});
$("#refresh").addEventListener("click", () => loadAll());
$("#series-mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  state.seriesMode = btn.dataset.mode;
  for (const b of $("#series-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
  if (state.data.timeseries) renderSmallMultiples();
});
$("#theme-toggle").addEventListener("click", () => setTheme(currentThemeIsDark() ? "light" : "dark"));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.getAttribute("data-theme")) renderAll();
});
function scheduleAuto() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if ($("#auto-refresh").checked) state.timer = setInterval(() => { if (!document.hidden) loadAll(); }, 60_000);
}
$("#auto-refresh").addEventListener("change", () => {
  try {
    localStorage.setItem("nutboard-auto-refresh", $("#auto-refresh").checked ? "on" : "off");
  } catch {}
  scheduleAuto();
});
try {
  if (localStorage.getItem("nutboard-auto-refresh") === "off") $("#auto-refresh").checked = false;
} catch {}

// ---------- sign-in (passkeys) ----------

const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L19 4M16 7l2.5 2.5M14 9l2 2"/></svg>';
const AUTH_ERRORS = {
  bad_setup_code: "Wrong setup code.",
  setup_locked: "Too many wrong codes. Restart the server for a new one.",
  setup_closed: "Setup is closed: a passkey already exists. Sign in instead.",
  unknown_passkey: "This passkey doesn’t belong to this dashboard.",
  expired: "The attempt expired. Try again.",
  verification_failed: "The passkey couldn’t be verified.",
  not_registered: "No passkey has been set up yet.",
  signed_out: "Your session ended. Sign in again.",
};

function showAuth(status, message = "") {
  state.locked = true;
  state.auth = { ...state.auth, ...status, authenticated: false };
  document.body.classList.add("locked");
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const setup = !state.auth.registered;
  const action = !passkeysSupported()
    ? `<p class="auth-msg bad">This browser can’t use passkeys. Open the dashboard in Safari or Chrome.</p>`
    : setup
      ? `<form id="setup-form" class="auth-form" novalidate>
          <label>Setup code
            <input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" required></label>
          <button type="submit" class="auth-btn">${KEY_ICON}Create passkey</button>
        </form>`
      : `<button type="button" class="auth-btn" data-action="signin">${KEY_ICON}Sign in with passkey</button>`;
  $("#auth-gate").innerHTML = `<section class="card auth-card">
    <div class="auth-icon"><img src="/logo-mark.png" alt="" width="140" height="140"></div>
    <h2>${setup ? "Set up your passkey" : "Sign in"}</h2>
    <p class="secondary">${
      setup
        ? "This dashboard has no passkey yet. Enter the one-time setup code from the server log, then confirm with Face ID or Touch ID. The passkey is saved in your iCloud Keychain and works on all your Apple devices."
        : "Use your passkey: Face ID or Touch ID."
    }</p>
    ${action}
    <p class="auth-msg" id="auth-msg" role="alert">${esc(message)}</p>
  </section>
  <section class="card public-fees" id="public-fees" hidden></section>`;
  $("#auth-gate").hidden = false;
  loadPublicFees();
}

/** The one thing anyone may see before signing in: what a reasonably sized payment costs here. */
async function loadPublicFees() {
  const box = $("#public-fees");
  if (!box) return;
  try {
    const f = await fetchJson("/api/public/fees");
    if (!f.range) return;
    const unit = f.unit;
    const RANGE_LABEL = { "30d": "last 30 days", "90d": "last 90 days", all: "all time" };
    const parts = [
      `<strong>${esc(fmtPctFine(f.totalRatio))}</strong> of the amount on average`,
      f.mintRatio === null ? `${esc(fmtPctFine(f.lnRatio))} Lightning routing` : `${esc(fmtPctFine(f.lnRatio))} Lightning routing + ${esc(fmtPctFine(f.mintRatio))} mint fee`,
      `median ${esc(fmtPctFine(f.medianTotalRatio))}`,
      `${esc(fmtPct(f.freeCount, f.count))} of payments paid no routing fee`,
    ];
    box.innerHTML = `<div class="label">Fees on this mint for payments of ${esc(fmtAmount(f.band.min, unit))} – ${esc(fmtAmount(f.band.max, unit))}
      <span class="muted">· ${esc(RANGE_LABEL[f.range] || f.range)}, ${esc(fmtInt(f.count))} payments</span></div>
      <div class="line">${parts.join(" · ")}${f.inputFeePpk ? ` · mint input fee ${esc(fmtInt(f.inputFeePpk))} ppk per proof` : ""}</div>`;
    box.hidden = false;
  } catch {
    /* the gate works without it */
  }
}

function authMessage(err) {
  if (err?.name === "NotAllowedError" || err?.name === "AbortError") return "Cancelled or timed out. Try again.";
  if (err?.name === "InvalidStateError") return "This device already has a passkey for the dashboard.";
  return AUTH_ERRORS[err?.code] || `Sign-in failed: ${err?.message ?? ""}`;
}

function authBusy(busy, message = "") {
  for (const b of $$(".auth-card button, .auth-card input")) b.disabled = busy;
  const msg = $("#auth-msg");
  if (msg) {
    msg.textContent = busy ? "Waiting for Face ID / Touch ID…" : message;
    msg.classList.toggle("bad", !busy && !!message);
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "Passkey";
  return `${device} · ${new Date().toISOString().slice(0, 10)}`;
}

async function signIn() {
  authBusy(true);
  try {
    const { flowId, options } = await post("/api/auth/login/options");
    const response = await usePasskey(options);
    await post("/api/auth/login/verify", { flowId, response });
    await enterApp();
  } catch (err) {
    authBusy(false, authMessage(err));
  }
}

async function setUp(code) {
  authBusy(true);
  try {
    const { flowId, options } = await post("/api/auth/register/options", { setupCode: code });
    const response = await createPasskey(options);
    await post("/api/auth/register/verify", { flowId, response, name: deviceName() });
    await enterApp();
  } catch (err) {
    authBusy(false, authMessage(err));
  }
}

async function enterApp() {
  state.locked = false;
  state.auth = { ...state.auth, registered: true, authenticated: true };
  document.body.classList.remove("locked");
  $("#auth-gate").hidden = true;
  $("#auth-gate").innerHTML = "";
  $("#signout").hidden = !!state.auth.authDisabled;
  await loadAll();
  scheduleAuto();
}

async function loadPasskeys() {
  const box = $("#passkeys");
  if (!box) return;
  if (state.auth?.authDisabled) {
    box.innerHTML = `<p class="muted">Sign-in is turned off (NUTBOARD_AUTH=off, local only).</p>`;
    $("#security-actions").hidden = true;
    return;
  }
  $("#security-actions").hidden = false;
  try {
    const list = await fetchJson("/api/auth/passkeys");
    box.innerHTML = `<ul class="passkey-list">${list
      .map(
        (p) => `<li class="passkey">
        <span class="key-icon">${KEY_ICON}</span>
        <div class="grow"><strong>${esc(p.name)}</strong>${p.current ? ' <span class="badge active">this session</span>' : ""}
          <span class="cell-sub">${p.device_type === "multiDevice" ? "synced passkey" : "this device only"} · added ${esc(fmtDate(p.created_at))} · ${p.last_used_at ? `last used ${esc(fmtDate(p.last_used_at))}` : "not used yet"}</span></div>
        <button type="button" class="small danger" data-remove-passkey="${esc(p.id)}" data-name="${esc(p.name)}" ${list.length <= 1 ? 'disabled title="The last passkey can’t be removed."' : ""}>Remove</button>
      </li>`,
      )
      .join("")}</ul>`;
  } catch (err) {
    box.innerHTML = `<p class="auth-msg bad">${esc(err.message)}</p>`;
  }
}

async function addPasskey() {
  const msg = $("#security-msg");
  msg.textContent = "Waiting for Face ID / Touch ID…";
  try {
    const { flowId, options } = await post("/api/auth/register/options");
    const response = await createPasskey(options);
    await post("/api/auth/register/verify", { flowId, response, name: deviceName() });
    msg.textContent = "Passkey added.";
    loadPasskeys();
  } catch (err) {
    msg.textContent = authMessage(err);
  }
}

async function signOut(everywhere = false) {
  await post(everywhere ? "/api/auth/logout-all" : "/api/auth/logout").catch(() => null);
  showAuth({ registered: true }, "Signed out.");
}

$("#auth-gate").addEventListener("submit", (e) => {
  if (e.target.id === "setup-form") {
    e.preventDefault();
    setUp(e.target.elements.code.value);
  }
});
$("#auth-gate").addEventListener("click", (e) => {
  if (e.target.closest("[data-action='signin']")) signIn();
});
$("#signout").addEventListener("click", () => signOut(false));
$("#security").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.action === "add-passkey") return addPasskey();
  if (btn.dataset.action === "signout") return signOut(false);
  if (btn.dataset.action === "signout-all") return signOut(true);
  if (btn.dataset.removePasskey) {
    if (!confirm(`Remove the passkey “${btn.dataset.name}”? It will no longer open this dashboard.`)) return;
    try {
      await post(`/api/auth/passkeys/${encodeURIComponent(btn.dataset.removePasskey)}`, undefined, "DELETE");
    } catch (err) {
      $("#security-msg").textContent = err.message;
    }
    loadPasskeys();
  }
});

async function boot() {
  try {
    const saved = localStorage.getItem("nutboard-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch {}
  try {
    state.auth = await fetchJson("/api/auth/status");
  } catch (err) {
    showError(`Could not reach the server: ${err.message}`);
    return;
  }
  if (!state.auth.authenticated) return showAuth(state.auth);
  await enterApp();
}

boot();
