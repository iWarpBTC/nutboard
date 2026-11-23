/* nutboard dashboard. Browser module; talks to the JSON API under /api behind passkey sign-in. */
import { createPasskey, passkeysSupported, usePasskey } from "/lib/passkey.js";


const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const state = {
  auth: null,
  locked: false,
  view: null, // "all" | "mint" | "lnbits" | "control"; chosen once the server says what there is to show
  mint: null, // id of the mint the mint view shows
  labels: { wallet: {}, account: {} }, // names given to LNbits wallets and accounts
  lnWallet: null, // LNbits wallet whose payments are listed; null lists all
  lnShowAll: false,
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

// What the connected mint offers (MintStats.features on the server); a Nutshell mint is assumed until health arrives.
const FEATURE_DEFAULTS = { balanceLog: true, exactSwaps: false, localTimestamps: true };
const feature = (name) => state.data.health?.features?.[name] ?? FEATURE_DEFAULTS[name];
const isCdk = () => state.data.health?.mintKind === "cdk";
/** Marks swap counts that are estimated rather than recorded by the mint. */
const approx = () => (feature("exactSwaps") ? "" : " ≈");
/** "20260811000000_add_x" -> "2026-08-11"; anything else is shown as it is. */
function schemaLabel(v) {
  if (!v) return "?";
  const m = /^(\d{4})(\d{2})(\d{2})\d{6}_/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
}

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
    const health = await fetchJson("/api/health", { mint: state.mint });
    state.data.health = health;
    state.mint = health.mint;
    const several = health.mints.length > 1 || !!health.lnbits;
    if (!state.view) state.view = several ? "all" : "mint";
    if ((state.view === "lnbits" && !health.lnbits) || (state.view === "control" && !health.killSwitch)) state.view = several ? "all" : "mint";
    if (state.view === "mint") await loadMint();
    else if (state.view === "lnbits") await loadLnbits();
    else if (state.view === "control") await loadControl();
    else await loadSummary();
    showError("");
    renderAll();
    loadPasskeys();
  } catch (err) {
    if (!state.locked) showError(`Could not load statistics: ${err.message}`);
  } finally {
    main.classList.remove("loading");
  }
}

/** Everything the detailed view of one mint shows. */
async function loadMint() {
  const mint = state.mint;
  const units = await fetchJson("/api/units", { mint });
  state.units = units;
  if (!state.unit || !units.includes(state.unit)) state.unit = units.includes("sat") ? "sat" : units[0];
  const unit = state.unit;
  const [overview, timeseries, fees, keysets, denominations, balanceLog, hourly, activity, audit] = await Promise.all([
    fetchJson("/api/overview", { mint, unit }),
    fetchJson("/api/timeseries", { mint, unit, range: state.range }),
    fetchJson("/api/fees", { mint, unit, range: state.range }),
    fetchJson("/api/keysets", { mint }),
    fetchJson("/api/denominations", { mint, unit }),
    fetchJson("/api/balance-log", { mint, unit, range: state.range === "24h" || state.range === "7d" ? "30d" : state.range }),
    fetchJson("/api/hourly", { mint, unit }),
    fetchJson("/api/activity", { mint, unit, limit: 40 }),
    fetchJson("/api/audit", { mint, unit }),
  ]);
  Object.assign(state.data, { overview, timeseries, keysets, denominations, balanceLog, hourly, activity, audit, fees });
}

async function loadSummary() {
  const [summary, kill] = await Promise.all([
    fetchJson("/api/summary"),
    state.data.health.killSwitch ? fetchJson("/api/kill") : Promise.resolve(null),
  ]);
  Object.assign(state.data, { summary, kill });
}

async function loadLnbits() {
  const [overview, wallets, payments, series, labels] = await Promise.all([
    fetchJson("/api/lnbits/overview"),
    fetchJson("/api/lnbits/wallets"),
    fetchJson("/api/lnbits/payments", { limit: 60, wallet: state.lnWallet }),
    fetchJson("/api/lnbits/timeseries", { range: state.range }),
    fetchJson("/api/labels"),
  ]);
  state.labels = labels;
  state.data.ln = { overview, wallets, payments, series };
}

async function loadControl() {
  state.data.kill = await fetchJson("/api/kill");
}

// ---------- rendering ----------
function renderAll() {
  if (!state.data.health) return;
  applyChartDefaults();
  renderChrome();
  if (state.view === "lnbits") renderLnbits();
  else if (state.view === "control") renderControl();
  else if (state.view === "all") renderSummary();
  else renderMint();
  renderFooter();
}

function renderMint() {
  if (!state.data.overview) return;
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
}

function renderStatus() {
  const h = state.data.health;
  const bar = $("#status-bar");
  const pills = [];
  pills.push(`<span class="pill ${h.readOnly ? "ok" : "fail"}"><span class="dot"></span>${h.readOnly ? "session read-only" : "SESSION NOT READ-ONLY"}</span>`);
  pills.push(`<span class="pill ${h.connection.roleCanWrite || h.connection.superuser ? "warn" : "ok"}"><span class="dot"></span>role ${esc(h.connection.user)}${h.connection.superuser ? " (superuser!)" : h.connection.roleCanWrite ? " (has write privileges)" : " (select-only)"}</span>`);
  pills.push(`<span class="pill detail"><span class="dot"></span>${esc(h.connection.database)} · PostgreSQL ${esc(h.connection.serverVersion)}</span>`);
  pills.push(
    isCdk()
      ? `<span class="pill detail" title="newest applied migration: ${esc(h.schemaVersion ?? "unknown")}"><span class="dot"></span>CDK schema ${esc(schemaLabel(h.schemaVersion))}</span>`
      : `<span class="pill detail"><span class="dot"></span>Nutshell db v${h.nutshellDbVersion ?? "?"}</span>`,
  );
  const tz = h.timeZone;
  if (!feature("localTimestamps")) {
    pills.push(`<span class="pill detail" title="the mint stores Unix time; this zone only decides the hour of day"><span class="dot"></span>hours of day in ${esc(h.mintTz)}</span>`);
  } else {
    pills.push(
      `<span class="pill ${tz?.hint ? "warn" : ""}" title="${esc(tz?.hint || (tz?.newestRow ? `newest ledger row ${tz.newestRow} mint local time` : ""))}"><span class="dot"></span>mint time zone ${esc(h.mintTz)}${
        tz?.newestRow ? ` · newest row ${esc(fmtAgo(new Date(Date.now() - (tz.ageConfiguredSeconds ?? 0) * 1000)))}` : ""
      }</span>`,
    );
    if (tz?.hint) pills.push(`<span class="pill warn"><span class="dot"></span>${esc(tz.hint)}</span>`);
  }
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
  tiles.push(tile("Input fees collected", L.feesPaid === null ? "–" : esc(fmtAmount(L.feesPaid, unit, { compact: true })), isCdk() ? "keyset_amounts.fee_collected" : "keysets.fees_paid"));
  tiles.push(tile("Lightning fees paid", esc(fmtAmount(o.melt.all.fee_paid, unit, { compact: true })), `of ${esc(fmtAmount(o.melt.all.fee_reserve, unit, { compact: true }))} reserved`));
  if (o.lastBalanceLog) {
    const b = o.lastBalanceLog;
    const reserve = b.backendBalance - b.keysetBalance;
    tiles.push(tile("Backend reserve", esc(fmtAmount(reserve, unit, { compact: true })), `backend ${esc(fmtAmount(b.backendBalance, unit, { compact: true }))} · logged ${esc(fmtAgo(b.time))}`, reserve < 0 ? "bad" : ""));
  } else if (feature("balanceLog")) {
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
  rows.push(row("mint", "Minted", "Lightning paid in, ecash issued", W.map((w) => cell(o.mint[w.key].amount, o.mint[w.key].count, isCdk() ? "mints" : "quotes")).join("")));
  rows.push(row("melt", "Melted", "ecash redeemed, Lightning paid out", W.map((w) => cell(o.melt[w.key].amount, o.melt[w.key].count, isCdk() ? "melts" : "quotes")).join("")));
  rows.push(row("swap", "Swapped", `ecash exchanged for new ecash${feature("exactSwaps") ? "" : " (≈ operations)"}`, W.map((w) => cell(o.signatures[w.key].swap_amount, o.signatures[w.key].swap_ops, `swaps${approx()}`)).join("")));
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
    { key: "mint", name: "Minted", color: p.mint, countLabel: isCdk() ? "mints" : "quotes" },
    { key: "melt", name: "Melted", color: p.melt, countLabel: isCdk() ? "melts" : "quotes" },
    { key: "swap", name: "Swapped", color: p.swap, countLabel: `swaps${approx()}` },
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
  // A mint that keeps no balance log (CDK) has nothing to chart: drop the card, the grid closes the gap.
  box.closest(".card").hidden = !feature("balanceLog");
  if (!feature("balanceLog")) return;
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
  $("#hourly-hint").textContent = `last 30 days, ${feature("localTimestamps") ? "mint local time" : "time zone"} (${state.data.health.mintTz})`;
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
      datasets: [bar("Mints", p.mint, "mints"), bar("Melts", p.melt, "melts"), bar(`Swaps${approx()}`, p.swap, "swaps")],
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
  $("#hourly-table").innerHTML = `<table><thead><tr><th>Hour</th><th class="num">Mints</th><th class="num">Melts</th><th class="num">Swaps${approx()}</th></tr></thead><tbody>${rows
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
  $("#keysets-table").innerHTML = `<thead><tr><th>Keyset</th><th>Unit</th><th>Fee ppk</th><th>${isCdk() ? "Created" : "First seen"}</th><th class="num">Issued</th><th class="num">Redeemed</th><th class="num">Pending</th><th class="num">Balance</th><th class="num">Fees paid</th><th>Ledger</th></tr></thead><tbody>${rows
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
  const b = state.data.health.build;
  const deployed = b
    ? `nutboard ${esc(b.version)} · commit <span class="mono">${esc(b.commit)}${b.dirty ? "+dirty" : ""}</span>${b.builtAt ? ` · deployed ${esc(fmtDate(b.builtAt))}` : ""}<br>`
    : "";
  const generatedAt =
    state.view === "mint" ? state.data.overview?.generatedAt
    : state.view === "lnbits" ? state.data.ln?.overview.generatedAt
    : state.view === "all" ? state.data.summary?.generatedAt
    : null;
  const note =
    state.view === "mint"
      ? `${feature("exactSwaps") ? "" : "Swap counts are approximate: Nutshell does not record a swap id, so outputs stored within the same second are counted as one swap. "}Blind signatures mean the mint cannot see who holds which notes; everything here is derived from issued and redeemed amounts only.`
      : state.view === "lnbits"
        ? "From the LNbits database: balances, amounts and times only. API keys, invoices, preimages and memos are not readable by this dashboard."
        : state.view === "control"
          ? "The kill switch stops services through a root-owned helper on the server; this dashboard cannot start anything."
          : "Each source is read from its own database with a SELECT-only role.";
  $("#footer").innerHTML = `${deployed}${generatedAt ? `Statistics generated ${esc(fmtDate(generatedAt))} from read-only queries. ` : ""}${note}`;
}

// ---------- views: all sources, one mint, LNbits, kill switch ----------
const VIEW_IDS = ["all", "mint", "lnbits", "control"];
const tile = (label, value, sub = "", cls = "") =>
  `<div class="tile ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || "");
const agoOr = (d, never = "never") => (d ? fmtAgo(d) : never);

/** The navigation and everything else that depends on which view is open. */
function renderChrome() {
  const h = state.data.health;
  const site = h.siteName || h.mintName || "nutboard";
  $("#mint-name").textContent = site;
  const current = state.view === "mint" ? h.mintName : state.view === "lnbits" ? h.lnbits?.name : state.view === "control" ? "Kill switch" : site;
  document.title = `${current || site} · nutboard`;
  const nav = $("#views");
  nav.hidden = !(h.mints.length > 1 || h.lnbits || h.killSwitch);
  const btn = (view, mint, label, cls = "") =>
    `<button type="button" class="${cls}" data-view="${view}"${mint ? ` data-mint="${esc(mint)}"` : ""} aria-pressed="${state.view === view && (view !== "mint" || state.mint === mint)}">${label}</button>`;
  nav.innerHTML = [
    btn("all", null, "Overview"),
    ...h.mints.map((m) => btn("mint", m.id, `${esc(m.name)}<span class="badge">${m.kind === "cdk" ? "CDK" : "Nutshell"}</span>`)),
    h.lnbits ? btn("lnbits", null, esc(h.lnbits.name)) : "",
    h.killSwitch ? btn("control", null, "Kill switch", "control danger") : "",
  ].join("");
  for (const id of VIEW_IDS) $(`#view-${id}`).hidden = state.view !== id;
  $("#status-bar").hidden = state.view !== "mint";
  $("#unit-select").parentElement.style.display = state.view === "mint" && state.units.length > 1 ? "" : "none";
  $("#range-control").style.display = state.view === "mint" || state.view === "lnbits" ? "" : "none";
}

function openView(view, mint = null) {
  state.view = view;
  if (mint) state.mint = mint;
  loadAll();
}

// ---------- overview of all sources ----------
const UNIT_STATE_CLASS = { active: "ok", activating: "warn", reloading: "warn", deactivating: "warn", inactive: "fail", failed: "fail" };

function renderSummary() {
  const s = state.data.summary;
  if (!s) return;
  const L = s.liabilitiesSat;
  $("#all-hero").innerHTML = `
    <div class="label">Owed in total</div>
    <div class="value">${esc(fmtAmount(L.total, "sat", { bare: true }))}<span class="unit">sat</span></div>
    <div class="sub">${esc(fmtAmount(L.mints, "sat"))} ecash outstanding${s.lnbits ? ` + ${esc(fmtAmount(L.lnbits, "sat"))} in LNbits wallets` : ""}</div>
    <div class="sub counter-line">What one Lightning node has to cover if it backs all of this. Units other than sat are not counted.</div>`;

  const tiles = [];
  for (const m of s.mints) {
    const sat = m.units.find((u) => u.unit === "sat") || m.units[0];
    tiles.push(
      m.error
        ? tile(esc(m.name), "–", `<span class="source-error">${esc(m.error)}</span>`, "bad")
        : tile(esc(m.name), sat ? esc(fmtAmount(sat.outstanding, sat.unit, { compact: true })) : "–", sat ? `outstanding · last operation ${esc(agoOr(sat.lastActivity))}` : "no keysets yet"),
    );
  }
  if (s.lnbits) {
    tiles.push(
      s.lnbits.error
        ? tile(esc(s.lnbits.name), "–", `<span class="source-error">${esc(s.lnbits.error)}</span>`, "bad")
        : tile(esc(s.lnbits.name), esc(fmtAmount(s.lnbits.balance, "sat", { compact: true })), `${esc(fmtInt(s.lnbits.fundedWallets))} funded wallets · last payment ${esc(agoOr(s.lnbits.lastPayment))}`),
    );
  }
  const k = state.data.kill;
  if (k?.enabled && k.units.length) {
    const known = k.units.filter((u) => u.state !== "unknown");
    const down = known.filter((u) => u.state !== "active");
    tiles.push(
      tile(
        "Services",
        known.length ? `${known.length - down.length} / ${known.length} running` : "–",
        down.length ? esc(down.map((u) => `${u.unit}: ${u.state}`).join(" · ")) : known.length ? "everything the kill switch covers is up" : "systemd could not be asked",
        down.length ? "bad" : "",
      ),
    );
  }
  $("#all-tiles").innerHTML = tiles.join("");

  const W = s.windows.filter((w) => w.key !== "all");
  const cell = (amount, count, unit, word) =>
    `<td class="num"><span title="${esc(fmtAmount(amount, unit))}">${esc(fmtAmount(amount, unit, { compact: true }))}</span><span class="cell-sub">${esc(fmtInt(count))} ${word}</span></td>`;
  const head = `<thead><tr><th>Source</th><th class="num">Owed</th>${W.map((w) => `<th class="num">In, ${esc(w.label)}</th><th class="num">Out, ${esc(w.label)}</th>`).join("")}<th>Last</th><th>Audit</th></tr></thead>`;
  const rows = [];
  for (const m of s.mints) {
    const kind = `<span class="badge">${m.kind === "cdk" ? "CDK" : "Nutshell"}</span>`;
    if (m.error) {
      rows.push(`<tr class="clickable" data-view="mint" data-mint="${esc(m.id)}"><td>${esc(m.name)} ${kind}</td><td colspan="${3 + W.length * 2}" class="source-error">${esc(m.error)}</td></tr>`);
      continue;
    }
    for (const u of m.units) {
      const audit = u.audit.fail ? `<span class="pill fail"><span class="dot"></span>${u.audit.fail} failing</span>` : u.audit.warn ? `<span class="pill warn"><span class="dot"></span>${u.audit.warn} warnings</span>` : `<span class="pill ok"><span class="dot"></span>clean</span>`;
      rows.push(`<tr class="clickable" data-view="mint" data-mint="${esc(m.id)}" data-unit="${esc(u.unit)}">
        <td>${esc(m.name)} ${kind}<span class="cell-sub">${esc(u.unit)}${u.pending ? ` · ${esc(fmtAmount(u.pending, u.unit))} pending` : ""}</span></td>
        <td class="num">${esc(fmtAmount(u.outstanding, u.unit))}</td>
        ${W.map((w) => cell(u.windows[w.key].minted.amount, u.windows[w.key].minted.count, u.unit, "minted") + cell(u.windows[w.key].melted.amount, u.windows[w.key].melted.count, u.unit, "melted")).join("")}
        <td>${esc(agoOr(u.lastActivity))}</td>
        <td>${audit}</td>
      </tr>`);
    }
  }
  if (s.lnbits && !s.lnbits.error) {
    const p = s.lnbits.payments;
    rows.push(`<tr class="clickable" data-view="lnbits">
      <td>${esc(s.lnbits.name)}<span class="cell-sub">sat · ${esc(fmtInt(s.lnbits.wallets))} wallets</span></td>
      <td class="num">${esc(fmtAmount(s.lnbits.balance, "sat"))}</td>
      ${W.map((w) => cell(p[w.key].received_amount, p[w.key].received_count, "sat", "received") + cell(p[w.key].sent_amount, p[w.key].sent_count, "sat", "sent")).join("")}
      <td>${esc(agoOr(s.lnbits.lastPayment))}</td>
      <td><span class="muted">n/a</span></td>
    </tr>`);
  } else if (s.lnbits) {
    rows.push(`<tr class="clickable" data-view="lnbits"><td>${esc(s.lnbits.name)}</td><td colspan="${3 + W.length * 2}" class="source-error">${esc(s.lnbits.error)}</td></tr>`);
  }
  $("#all-table").innerHTML = `${head}<tbody>${rows.join("")}</tbody>`;
}

// ---------- LNbits ----------
const walletLabel = (w) => state.labels.wallet[w.id] || w.name || shortId(w.id);
const accountLabel = (w) => state.labels.account[w.account] || w.accountName || shortId(w.account);

function renderLnbits() {
  const ln = state.data.ln;
  if (!ln) return;
  const o = ln.overview;
  const P = o.payments;
  $("#ln-hero").innerHTML = `
    <div class="label">LNbits owes its wallets</div>
    <div class="value">${esc(fmtAmount(o.balance, "sat", { bare: true }))}<span class="unit">sat</span></div>
    <div class="sub">${esc(fmtInt(o.wallets))} wallets in ${esc(fmtInt(o.accounts))} accounts, ${esc(fmtInt(o.fundedWallets))} of them funded${o.deletedWallets ? ` · ${esc(fmtInt(o.deletedWallets))} deleted` : ""}</div>
    <div class="sub counter-line">Sum of LNbits' own balance view${o.schemaVersion ? ` · database version ${esc(o.schemaVersion)}` : ""}</div>`;
  $("#ln-tiles").innerHTML = [
    tile("Last payment", o.lastPayment ? `<span title="${esc(fmtDate(o.lastPayment))}">${esc(fmtAgo(o.lastPayment))}</span>` : "never", "settled, either direction"),
    tile("Received (24 h)", esc(fmtAmount(P.h24.received_amount, "sat", { compact: true })), `${esc(fmtInt(P.h24.received_count))} payments`),
    tile("Received (30 d)", esc(fmtAmount(P.d30.received_amount, "sat", { compact: true })), `${esc(fmtInt(P.d30.received_count))} payments`),
    tile("Sent (30 d)", esc(fmtAmount(P.d30.sent_amount, "sat", { compact: true })), `${esc(fmtInt(P.d30.sent_count))} payments · ${esc(fmtAmount(P.d30.fees, "sat"))} fees`),
    tile("Between wallets (30 d)", esc(fmtAmount(P.d30.internal_amount, "sat", { compact: true })), `${esc(fmtInt(P.d30.internal_count))} transfers, no Lightning`),
    tile("In flight", esc(fmtAmount(o.pendingOut.amount, "sat", { compact: true })), `${esc(fmtInt(o.pendingOut.count))} outgoing payments pending`, o.pendingOut.count ? "bad" : ""),
    tile("Open invoices", esc(fmtInt(o.openInvoices)), "created in the last day, not paid yet"),
  ].join("");

  const W = o.windows;
  const row = (swatch, label, hint, cells) =>
    `<tr><td><div class="row-label"><span class="swatch ${swatch}"></span><div>${label}<span class="cell-sub">${hint}</span></div></div></td>${cells}</tr>`;
  const cell = (amount, count, word) =>
    `<td class="num"><span title="${esc(fmtAmount(amount, "sat"))}">${esc(fmtAmount(amount, "sat", { compact: true }))}</span><span class="cell-sub">${esc(fmtInt(count))} ${word}</span></td>`;
  $("#ln-window-table").innerHTML = `<thead><tr><th></th>${W.map((w) => `<th class="num">${esc(w.label)}</th>`).join("")}</tr></thead><tbody>${[
    row("mint", "Received", "invoices paid into wallets", W.map((w) => cell(P[w.key].received_amount, P[w.key].received_count, "payments")).join("")),
    row("melt", "Sent", "paid out over Lightning", W.map((w) => cell(P[w.key].sent_amount, P[w.key].sent_count, "payments")).join("")),
    row("swap", "Between wallets", "inside this LNbits; counted in Received as well", W.map((w) => cell(P[w.key].internal_amount, P[w.key].internal_count, "transfers")).join("")),
    row("neutral", "Lightning fees", "paid on outgoing payments", W.map((w) => `<td class="num">${esc(fmtAmount(P[w.key].fees, "sat"))}</td>`).join("")),
    row("neutral", "Failed", "payments and invoices that did not go through", W.map((w) => `<td class="num">${esc(fmtInt(P[w.key].failed_count))}</td>`).join("")),
  ].join("")}</tbody>`;

  const p = palette();
  const t = ln.series;
  const bar = (label, color, points) => ({
    label,
    data: points.map((x) => x.amount),
    backgroundColor: withAlpha(color, 0.85),
    hoverBackgroundColor: color,
    borderRadius: 3,
    maxBarThickness: 22,
  });
  mountChart("ln-chart", {
    type: "bar",
    data: { labels: t.buckets.map((b) => bucketLabel(b, t.bin)), datasets: [bar("Received", p.mint, t.received), bar("Sent", p.melt, t.sent)] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: ${fmtAmount(item.raw, "sat")} · ${fmtInt((item.datasetIndex === 0 ? t.received : t.sent)[item.dataIndex].count)} payments` } },
      },
      scales: (() => {
        const sc = baseScales(p);
        sc.y.ticks.callback = (v) => fmtAxis(v, "sat");
        return sc;
      })(),
    },
  });

  const shown = ln.wallets.filter((w) => state.lnShowAll || (!w.deleted && !w.accountDeleted && (w.balance > 0 || w.payments > 0)));
  const renameBtn = (kind, id, current) =>
    `<button type="button" class="rename" data-rename="${kind}" data-id="${esc(id)}" data-current="${esc(current || "")}" title="Name this ${kind} in nutboard" aria-label="Name this ${kind}">✎</button>`;
  $("#ln-wallets").innerHTML = `<thead><tr><th>Wallet</th><th>Account</th><th class="num">Balance</th><th class="num">Received</th><th class="num">Sent</th><th class="num">Payments</th><th>Last activity</th></tr></thead><tbody>${
    shown
      .map((w) => {
        const label = state.labels.wallet[w.id];
        const accLabel = state.labels.account[w.account];
        return `<tr class="clickable${state.lnWallet === w.id ? " selected" : ""}" data-wallet="${esc(w.id)}">
          <td><strong>${esc(walletLabel(w))}</strong>${renameBtn("wallet", w.id, label)}${w.deleted ? ' <span class="badge">deleted</span>' : w.accountDeleted ? ' <span class="badge">deleted account</span>' : ""}
            <span class="cell-sub">${label && w.name ? `${esc(w.name)} · ` : ""}<span class="mono">${esc(shortId(w.id))}</span>${w.currency ? ` · shown in ${esc(w.currency)}` : ""}</span></td>
          <td>${esc(accountLabel(w))}${renameBtn("account", w.account, accLabel)}
            <span class="cell-sub">${accLabel && w.accountName ? `${esc(w.accountName)} · ` : ""}<span class="mono">${esc(shortId(w.account))}</span></span></td>
          <td class="num">${esc(fmtAmount(w.balance, "sat"))}</td>
          <td class="num">${esc(fmtAmount(w.received, "sat"))}<span class="cell-sub">${esc(fmtAmount(w.received30d, "sat"))} in 30 d</span></td>
          <td class="num">${esc(fmtAmount(w.sent, "sat"))}<span class="cell-sub">${esc(fmtAmount(w.sent30d, "sat"))} in 30 d</span></td>
          <td class="num">${esc(fmtInt(w.payments))}</td>
          <td>${w.lastActivity ? `${esc(fmtAgo(w.lastActivity))}<span class="cell-sub">${esc(fmtDate(w.lastActivity))}</span>` : '<span class="muted">never</span>'}</td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="7" class="empty">no wallets with a balance or payments</td></tr>`
  }</tbody>`;
  $("#ln-show-all").checked = state.lnShowAll;

  const byId = new Map(ln.wallets.map((w) => [w.id, w]));
  const picked = state.lnWallet ? byId.get(state.lnWallet) : null;
  $("#ln-payments-hint").innerHTML = picked
    ? `payments of <strong>${esc(walletLabel(picked))}</strong> · <button type="button" class="small" data-all-payments>show all wallets</button>`
    : "newest first, all wallets; click a wallet above to see only its payments";
  $("#ln-payments").innerHTML = `<thead><tr><th>When</th><th>Wallet</th><th class="num">Amount</th><th class="num">Fee</th><th>Status</th><th>Via</th></tr></thead><tbody>${
    ln.payments
      .map((x) => {
        const w = byId.get(x.walletId);
        const status = x.status === "success" ? '<span class="pill ok"><span class="dot"></span>settled</span>' : x.status === "pending" ? '<span class="pill warn"><span class="dot"></span>pending</span>' : `<span class="pill fail"><span class="dot"></span>${esc(x.status)}</span>`;
        return `<tr><td>${esc(fmtAgo(x.at))}<span class="cell-sub">${esc(fmtDate(x.at))}</span></td>
          <td>${esc(w ? walletLabel(w) : shortId(x.walletId))}</td>
          <td class="num ${x.amount > 0 ? "amount-in" : "amount-out"}">${x.amount > 0 ? "+" : "−"}${esc(fmtAmount(Math.abs(x.amount), "sat"))}</td>
          <td class="num muted">${x.fee ? esc(fmtAmount(x.fee, "sat")) : ""}</td>
          <td>${status}</td>
          <td class="muted">${x.internal ? "between wallets" : esc(x.tag || "")}</td></tr>`;
      })
      .join("") || `<tr><td colspan="6" class="empty">no payments</td></tr>`
  }</tbody>`;
}

async function renameLabel(kind, id, current) {
  const what = kind === "wallet" ? "wallet" : "account";
  const name = prompt(`Name for this ${what} in nutboard (leave empty to remove). It is stored here only, never in LNbits.`, current || "");
  if (name === null) return;
  try {
    state.labels = await post("/api/labels", { kind, id, name }, "PUT");
    renderLnbits();
  } catch (err) {
    showError(`Could not save the name: ${err.message}`);
  }
}

// ---------- kill switch ----------
const KILL_GROUP_LABEL = { mints: "Mints", lnbits: "LNbits", "lnd-link": "Link to the Lightning node" };

function renderControl() {
  const k = state.data.kill;
  if (!k?.enabled) return;
  $("#kill-problems").innerHTML = k.problems.map((x) => `<div class="kill-problem">${esc(x)}</div>`).join("");
  $("#kill-units").innerHTML = `<thead><tr><th>Group</th><th>Unit</th><th>State</th></tr></thead><tbody>${
    k.units
      .map((u) => `<tr><td>${esc(KILL_GROUP_LABEL[u.group] || u.group)}</td><td class="mono">${esc(u.unit)}</td>
        <td><span class="pill ${UNIT_STATE_CLASS[u.state] || ""}"><span class="dot"></span>${esc(u.state)}</span></td></tr>`)
      .join("") || `<tr><td colspan="3" class="empty">no units are listed for the kill switch</td></tr>`
  }</tbody>`;
  $("#kill-targets").innerHTML = k.targets
    .map((t) => {
      const units = k.units.filter((u) => t.groups.includes(u.group)).map((u) => u.unit);
      const waiting = k.pending.includes(t.id);
      return `<div class="kill-target${t.catastrophic ? " catastrophic" : ""}">
        <div class="what"><strong>${esc(t.label)}</strong><p>${esc(t.description)}</p>
          <span class="cell-sub mono">${esc(units.join("  ") || "no units listed")}</span></div>
        <button type="button" data-kill="${esc(t.id)}" ${waiting ? "disabled" : ""}>${waiting ? "Requested…" : esc(t.label)}</button>
      </div>`;
    })
    .join("");
  $("#kill-log").innerHTML = `<thead><tr><th>When</th><th>What</th><th>Confirmed with</th></tr></thead><tbody>${
    k.log
      .map((l) => `<tr><td>${esc(fmtDate(l.at))}<span class="cell-sub">${esc(fmtAgo(l.at))}</span></td>
        <td>${esc(k.targets.find((t) => t.id === l.target)?.label || l.target)}</td><td>${esc(l.passkey || "–")}</td></tr>`)
      .join("") || `<tr><td colspan="3" class="empty">the kill switch has not been used</td></tr>`
  }</tbody>`;
}

// A pull is confirmed in a dialog: the phrase is typed there, and the tap on "Confirm" opens the passkey
// sheet. iOS shows that sheet only while a tap is being handled, so the sign-in challenge is fetched when the
// dialog opens and navigator.credentials.get is the first thing the tap does, before anything is awaited.
const killUi = { target: null, flow: null, busy: false };
const KILL_FLOW_MAX_AGE_MS = 4 * 60_000; // the server keeps a challenge for five minutes
const killNeedsPasskey = () => !state.data.health?.authDisabled;

function killSay(text, bad = false) {
  const msg = $("#kill-dialog-msg");
  msg.textContent = text;
  msg.classList.toggle("bad", bad);
}
const killPhraseOk = () => !!killUi.target && $("#kill-input").value.trim().toUpperCase() === killUi.target.confirm;
function syncKillDialog() {
  const ready = !killNeedsPasskey() || !!killUi.flow;
  $("#kill-confirm").disabled = killUi.busy || !killPhraseOk() || !ready;
  $("#kill-confirm").textContent = killNeedsPasskey() ? "Confirm with passkey" : "Confirm";
  $("#kill-input").disabled = killUi.busy;
}

/** Fetches a fresh sign-in challenge ahead of the tap. Each challenge works once. */
async function prepareKillFlow() {
  killUi.flow = null;
  syncKillDialog();
  if (!killNeedsPasskey()) return;
  const target = killUi.target;
  try {
    const flow = await post("/api/auth/login/options");
    if (killUi.target === target) killUi.flow = { ...flow, at: Date.now() };
  } catch (err) {
    killSay(`Could not prepare the passkey check: ${err.message}`, true);
  }
  syncKillDialog();
}

function openKillDialog(targetId) {
  const k = state.data.kill;
  const t = k?.targets.find((x) => x.id === targetId);
  if (!t) return;
  killUi.target = t;
  killUi.busy = false;
  $("#kill-dialog-title").textContent = t.label;
  $("#kill-dialog-text").textContent = `${t.description} This cannot be undone from the dashboard.`;
  $("#kill-dialog-units").textContent = k.units.filter((u) => t.groups.includes(u.group)).map((u) => u.unit).join("  ");
  $("#kill-dialog-phrase").textContent = t.confirm;
  $("#kill-input").value = "";
  killSay("");
  $("#kill-dialog").showModal();
  $("#kill-input").focus();
  prepareKillFlow();
}

function closeKillDialog() {
  killUi.target = null;
  killUi.flow = null;
  if ($("#kill-dialog").open) $("#kill-dialog").close();
}

/** Runs inside the tap on "Confirm". Nothing may be awaited before the passkey call. */
function confirmKill() {
  const t = killUi.target;
  if (!t || killUi.busy || !killPhraseOk()) return;
  let signedIn = Promise.resolve();
  if (killNeedsPasskey()) {
    const flow = killUi.flow;
    if (!flow || Date.now() - flow.at > KILL_FLOW_MAX_AGE_MS) {
      killSay("The passkey check had expired and is being renewed. Tap Confirm again.", true);
      prepareKillFlow();
      return;
    }
    killUi.flow = null;
    signedIn = usePasskey(flow.options).then((response) => post("/api/auth/login/verify", { flowId: flow.flowId, response }));
  }
  killUi.busy = true;
  syncKillDialog();
  killSay(killNeedsPasskey() ? "Confirm with Face ID / Touch ID…" : "Sending…");
  finishKill(t, signedIn);
}

async function finishKill(t, signedIn) {
  try {
    await signedIn;
    state.data.kill = await post("/api/kill", { target: t.id, confirm: t.confirm });
  } catch (err) {
    killUi.busy = false;
    const refused = err?.name === "NotAllowedError" || err?.name === "AbortError";
    killSay(
      refused
        ? "Nothing was done: the passkey was not confirmed (cancelled, timed out, or the browser did not show the prompt)."
        : `Nothing was done: ${AUTH_ERRORS[err?.code] || err?.message || "unknown error"}`,
      true,
    );
    if (killUi.target === t) prepareKillFlow(); // a challenge is used up by any attempt
    return;
  }
  killUi.busy = false;
  closeKillDialog();
  const msg = $("#kill-msg");
  msg.textContent = `Requested: ${t.label}. The services stop within a few seconds; the table above shows when.`;
  msg.classList.remove("bad");
  renderControl();
  const again = async () => {
    if (state.view !== "control") return;
    try {
      state.data.kill = await fetchJson("/api/kill");
      renderControl();
    } catch {
      /* the next refresh will show it */
    }
  };
  setTimeout(again, 2500);
  setTimeout(again, 8000);
}

$("#views").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (btn) openView(btn.dataset.view, btn.dataset.mint || null);
});
$("#all-table").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-view]");
  if (!row) return;
  if (row.dataset.unit) state.unit = row.dataset.unit;
  openView(row.dataset.view, row.dataset.mint || null);
});
$("#view-lnbits").addEventListener("click", (e) => {
  const rename = e.target.closest("button[data-rename]");
  if (rename) return renameLabel(rename.dataset.rename, rename.dataset.id, rename.dataset.current);
  if (e.target.closest("button[data-all-payments]")) {
    state.lnWallet = null;
    return loadAll();
  }
  const row = e.target.closest("tr[data-wallet]");
  if (row) {
    state.lnWallet = state.lnWallet === row.dataset.wallet ? null : row.dataset.wallet;
    loadAll();
  }
});
$("#ln-show-all").addEventListener("change", (e) => {
  state.lnShowAll = e.target.checked;
  renderLnbits();
});
$("#kill-targets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-kill]");
  if (btn) openKillDialog(btn.dataset.kill);
});
$("#kill-input").addEventListener("input", syncKillDialog);
$("#kill-confirm").addEventListener("click", confirmKill);
$("#kill-cancel").addEventListener("click", closeKillDialog);
$("#kill-dialog").addEventListener("close", () => {
  killUi.target = null;
  killUi.flow = null;
});
// Enter in the field must not submit the form: confirming has to be a tap on the button.
$("#kill-form").addEventListener("submit", (e) => e.preventDefault());

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
