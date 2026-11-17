// Dashboard client. Plain ES modules, no build step.
// UI texts are German, code is English.

const GAME_STATE_LABELS = {0: "Vorbereitung", 1: "Läuft", 2: "Pausiert", 3: "Beendet"};
const RESULT_LABELS = {
  0: ["OK", "ok"],
  1: ["Abklingzeit", "warn"],
  2: ["Zu wenig Punkte", "warn"],
  3: ["Schreibfehler", "bad"],
  4: ["Station veraltet", "bad"],
  5: ["Station deaktiviert", "warn"],
};
const TX_FLAGS = {VERIFIED: 1, HAS_TIME: 2, FRESH_CARD: 4, SINGLE_SLOT: 8};

const state = {
  tab: "monitor",
  stats: null,
  settings: null,
  teams: [],
  nodeTypes: [],
  gateway: null,
  players: [],
  leaderboard: {players: [], teams: []},
  nodes: [],
  txs: [],
  txFilter: {uid: "", node: "", result: ""},
  txHasMore: true,
  playerSearch: "",
  playerTeamFilter: "",
  newTxIds: new Set(),
  feed: [], // latest transactions for the leaderboard side panel (unfiltered)
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const fmtNum = (n) => Number(n || 0).toLocaleString("de-DE");
const fmtSigned = (n) => (n > 0 ? `+${fmtNum(n)}` : fmtNum(n));
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString("de-DE") : "–");
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString("de-DE") : "–");

function fmtAgo(ms) {
  if (!ms) return "nie";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "gerade eben";
  if (s < 60) return `vor ${s} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
}

function fmtDuration(sec) {
  if (sec === undefined || sec === null) return "–";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? {"Content-Type": "application/json"} : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function teamById(id) {
  return state.teams.find((t) => t.id === id) || null;
}

function teamChip(teamId) {
  const t = teamById(teamId);
  if (!t) return '<span class="muted">–</span>';
  return `<span class="team-chip"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>`;
}

function resultBadge(result) {
  const [label, cls] = RESULT_LABELS[result] || [`#${result}`, ""];
  return `<span class="badge ${cls}">${label}</span>`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

// Loads the global state. If it shows that another game became active (no
// matter which update noticed it first), everything belonging to the previous
// game is replaced: transactions, players, stations, filters.
async function loadState() {
  const s = await api("GET", "/state");
  // Read after the request: of two overlapping calls only the first one to
  // finish sees the switch.
  const prevGameId = state.game?.id;
  const prevEpoch = state.settings?.gameId;
  state.game = s.game;
  state.settings = s.settings;
  // Another game was loaded or created: the radio mesh is rebuilt, so the map
  // starts again with the automatic layout (manual positions are dropped).
  if (prevEpoch !== undefined && prevEpoch !== s.settings.gameId) resetTopoLayout();
  state.adjVersion = s.adjVersion;
  state.teams = s.teams;
  state.nodeTypes = s.nodeTypes;
  state.gateway = s.gateway;
  renderStatus();
  if (prevGameId !== undefined && prevGameId !== s.game?.id) await onGameSwitched();
}

async function onGameSwitched() {
  teamDraft = null;
  state.txFilter = {uid: "", node: "", result: ""};
  state.playerTeamFilter = "";
  state.feed = [];
  state.txs = [];
  state.newTxIds.clear();
  closeModal();
  await Promise.all([loadPlayers(), loadNodes(), loadFeed()]);
  chartAnim.clear();
  await switchTab(state.tab, {push: false});
  toast(`Aktives Spiel: ${state.game.name}`);
}

async function loadGateway() {
  const g = await api("GET", "/gateway");
  state.gateway = g;
  state.gatewayLog = g.log;
  renderStatus();
  if (state.tab === "settings") renderGatewayLog();
}

async function loadPlayers() {
  [state.players, state.leaderboard] = await Promise.all([api("GET", "/players"), api("GET", "/leaderboard")]);
}

async function loadNodes() {
  state.nodes = await api("GET", "/nodes");
}

async function loadTransactions(append = false) {
  const q = new URLSearchParams({limit: "100"});
  if (state.txFilter.uid) q.set("uid", state.txFilter.uid);
  if (state.txFilter.node) q.set("node", state.txFilter.node);
  if (state.txFilter.result !== "") q.set("result", state.txFilter.result);
  if (append && state.txs.length) q.set("before", state.txs[state.txs.length - 1].id);
  const rows = await api("GET", `/transactions?${q}`);
  state.txs = append ? state.txs.concat(rows) : rows;
  state.txHasMore = rows.length === 100;
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

function renderGameState() {
  const s = state.settings;
  if (!s) return;
  $("#game-state-bar").innerHTML = `
    <span class="label game-name" title="Aktuelles Spiel – verwalten unter „Spiele“">${esc(state.game?.name ?? "")}</span>
    <div class="segmented compact">
      ${[0, 1, 2, 3]
        .map((st) => {
          // Vorbereitung cannot be re-entered once the game has left it.
          const locked = st === 0 && s.state !== 0;
          const title = locked ? ' title="Nach Spielbeginn nicht mehr wählbar"' : "";
          return `<button data-state="${st}" class="st-${st} ${s.state === st ? "active" : ""}" ${s.state === st || locked ? "disabled" : ""}${title}>${GAME_STATE_LABELS[st]}</button>`;
        })
        .join("")}
    </div>`;
  document.querySelectorAll("#game-state-bar button").forEach((b) => {
    b.onclick = () =>
      run(async () => {
        state.settings = await api("PATCH", "/settings", {state: Number(b.dataset.state)});
        renderGameState();
        if (state.tab === "settings") renderSettings();
      }, `Spielstatus: ${GAME_STATE_LABELS[b.dataset.state]}`);
  });
}

function renderStatus() {
  const g = state.gateway;
  const parts = [];
  renderGameState();
  if (g) {
    if (!g.connected) {
      parts.push('<span class="badge bad">Bridge-Station: Nicht verbunden</span>');
    } else if (g.simulated) {
      parts.push('<span class="badge warn" title="Simulierte Bridge-Station mit virtuellen Stationen und Karten">Simulation verbunden</span>');
    } else {
      const stale = !g.lastSeen || Date.now() - g.lastSeen > 15000;
      const ql = g.gateway?.ql ?? 0;
      parts.push(`<span class="badge ${stale ? "warn" : "ok"}" title="${esc(g.path || "")}">Bridge-Station: ${stale ? "Antwortet nicht" : "Verbunden"}</span>`);
      if (ql > 0) parts.push(`<span class="badge warn" title="Nachrichten in der Bridge-Station, noch nicht in der DB">Puffer: ${ql}</span>`);
    }
  }
  const online = state.nodes.filter((n) => n.online).length;
  if (state.nodes.length) {
    parts.push(`<span class="badge ${online === state.nodes.length ? "ok" : "warn"}">Stationen ${online}/${state.nodes.length}</span>`);
  }
  parts.push(`<span class="badge info" title="Spieler im aktuellen Spiel">Spieler: ${state.players.length}</span>`);
  $("#status").innerHTML = parts.join("");
}

// ---------------------------------------------------------------------------
// tab: monitor (home page)
// ---------------------------------------------------------------------------
// Key figures, radio map with transaction pulses, live transactions, team
// chart and top players. The page skeleton is built once; sections are
// updated individually so running pulse animations survive refreshes.

async function loadStats() {
  state.stats = await api("GET", "/stats");
}

function renderMonitor() {
  const tab = $("#tab-monitor");
  if (!tab.querySelector("#mon-topo")) {
    tab.innerHTML = `
      <div class="kpis" id="mon-kpis"></div>
      <div class="mon-grid">
        <div class="panel mon-map">
          <div class="row" style="margin-bottom:8px">
            <h2 style="margin:0">Funknetz</h2><span class="spacer"></span>${topoLegendHtml()}
      
            <button class="btn small" id="mon-topo-reset" title="Stationen auf der Karte wieder automatisch nach Hops anordnen (verschobene Positionen werden verworfen; das Funknetz selbst bleibt unverändert)">Mesh zurücksetzen</button>
            <label class="check small topo-fallback" title="Funkverbindungen anzeigen, die gerade nicht als Route genutzt werden (Ausweichwege, falls eine Verbindung ausfällt)"><input type="checkbox" data-topo-fallback ${topo.showFallback ? "checked" : ""}> Show Ausweichrouten</label>
          </div>
          <div id="mon-topo-hint"></div>
          <div class="topo-wrap">
            <div id="mon-topo" class="topo"></div>
          </div>
          <p class="small muted" style="margin-bottom:0">Funkverkehr als wandernde Punkte: Scans in der Teamfarbe (grau ohne Team) von der Station zur Bridge-Station (roter Ring = abgelehnt). Alles andere grau – von der Bridge-Station an die Stationen: Spielstatus, Einstellungen, Korrekturen und Befehle (große Punkte), Empfangsbestätigungen für Scans (kleine Punkte) und alle 5 s der Beacon (winzige Punkte); von den Stationen zur Bridge-Station: Heartbeats und wiederholte Scans (kleine Punkte).</p>
        </div>
        <div class="mon-scores">
          <div class="panel"><h2>Teams</h2><div id="mon-teams"></div></div>
          <div class="panel"><h2>Top 10 Spieler</h2><div id="mon-players"></div></div>
        </div>
        <aside class="panel mon-feed">
          <div class="feed-head"><h2>Transaktionen</h2><span class="badge info">Live</span></div>
          <ul class="feed-list" id="mon-feed"></ul>
        </aside>
      </div>`;
    $("#mon-topo-reset").onclick = resetTopoLayout;
    attachFallbackToggle(tab);
  }
  renderMonitorKpis();
  renderMonitorMap();
  renderMonitorScores();
  renderMonitorFeed();
}

function kpi(label, value, sub = "", cls = "") {
  return `<div class="kpi ${cls}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div></div>`;
}

function renderMonitorKpis() {
  const el = $("#mon-kpis");
  if (!el) return;
  const s = state.stats || {};
  const g = state.gateway || {};
  const online = state.nodes.filter((n) => n.online);
  const offline = state.nodes.length - online.length;
  const stationQueue = online.reduce((sum, n) => sum + (n.status?.queueLen || 0), 0);
  const bridgeQueue = g.gateway?.ql || 0;
  const unsynced = online.filter((n) => n.inSync && (!n.inSync.game || !n.inSync.node || !n.inSync.adj)).length;
  const bridge = g.simulated
    ? kpi("Bridge-Station", "Simuliert", "Keine echte Hardware", "warn")
    : g.connected
      ? kpi("Bridge-Station", "Verbunden", esc(g.path || ""), "ok")
      : kpi("Bridge-Station", "Getrennt", "Per USB anschließen", "bad");
  el.innerHTML = [
    kpi("Spielstatus", esc(GAME_STATE_LABELS[state.settings?.state] ?? "–"), esc(state.game?.name ?? ""), state.settings ? `st-${state.settings.state}` : ""),
    bridge,
    kpi("Stationen online", `${online.length}/${state.nodes.length}`, offline ? `⚠ ${offline} offline` : unsynced ? `⟳ ${unsynced} werden synchronisiert` : "alle erreichbar", offline ? "warn" : ""),
    kpi("Spieler", fmtNum(s.players ?? state.players.length), `${state.teams.length} Teams`),
    kpi("Punkte gesamt", fmtNum(s.points ?? 0), "auf allen Karten"),
    kpi("Transaktionen", fmtNum(s.transactions ?? 0), `${fmtNum(s.last5min ?? 0)} in den letzten 5 min`),
    kpi("Puffer", fmtNum(stationQueue + bridgeQueue), stationQueue + bridgeQueue ? "noch nicht in der Datenbank" : "alles übertragen", stationQueue + bridgeQueue ? "warn" : ""),
  ].join("");
}

function renderMonitorMap() {
  if (topo.drag) return;
  renderTopology($("#mon-topo"), $("#mon-topo-hint"));
}

function renderMonitorScores() {
  const teamsEl = $("#mon-teams");
  if (teamsEl) {
    const prev = captureTeamChart(teamsEl);
    teamsEl.innerHTML = teamChartHtml(state.leaderboard.teams, "monitor") || '<div class="empty">Keine Teams</div>';
    animateTeamChart(teamsEl, prev, "monitor");
  }
  const playersEl = $("#mon-players");
  if (playersEl) {
    const top = state.leaderboard.players.slice(0, 10);
    playersEl.innerHTML = top.length
      ? `<ol class="lb-list compact">${top
          .map(
            (p, i) => `<li class="lb-item clickable" data-player="${esc(p.uid)}" title="Spieler bearbeiten">
              <div class="lb-rank">${i + 1}</div>
              <div><div class="lb-name">${esc(p.name)}</div><div class="small muted">${teamChip(p.teamId)}</div></div>
              <div class="lb-points">${fmtNum(p.points)}</div>
            </li>`,
          )
          .join("")}</ol>`
      : '<div class="empty">Noch keine Spieler.</div>';
  }
}

function renderMonitorFeed() {
  const el = $("#mon-feed");
  if (!el) return;
  el.innerHTML = state.feed.length ? state.feed.slice(0, 60).map(feedItem).join("") : '<li class="empty">Noch keine Transaktionen.</li>';
}

const refreshStats = debounce(async () => {
  await loadStats();
  if (state.tab === "monitor") renderMonitorKpis();
}, 1000);

// ---------------------------------------------------------------------------
// tab: leaderboard
// ---------------------------------------------------------------------------

function renderLeaderboard() {
  const {players, teams} = state.leaderboard;
  const maxP = Math.max(1, ...players.map((p) => p.points));

  const playerItems = players
    .map(
      (p, i) => `<li class="lb-item clickable" data-player="${esc(p.uid)}" title="Spieler bearbeiten">
        <div class="lb-rank">${i + 1}</div>
        <div>
          <div class="lb-name">${esc(p.name)}</div>
          <div class="small muted">${teamChip(p.teamId)}${p.pendingDelta ? ` · <span title="Korrektur wird beim nächsten Scan übernommen">ausstehend ${fmtSigned(p.pendingDelta)}</span>` : ""}</div>
          <div class="lb-bar"><span style="width:${(p.points / maxP) * 100}%;background:${esc(p.teamColor || "var(--accent)")}"></span></div>
        </div>
        <div class="lb-points">${fmtNum(p.points)}</div>
      </li>`,
    )
    .join("");

  const teamItems = teams
    .map(
      (t, i) => `<li class="lb-item">
        <div class="lb-rank">${i + 1}</div>
        <div>
          <div class="lb-name team-chip"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</div>
          <div class="small muted">${t.members} Spieler · Ø ${fmtNum(t.members ? Math.round(t.points / t.members) : 0)}</div>
        </div>
        <div class="lb-points">${fmtNum(t.points)}</div>
      </li>`,
    )
    .join("");

  const tab = $("#tab-leaderboard");
  const previousChart = captureTeamChart(tab);
  const teamChart = teamChartHtml(teams, "leaderboard");
  tab.innerHTML = `
    <p class="muted small" style="margin-top:0">Punkte = letzter bekannter Stand auf den Karten. Aktualisiert sich live.</p>
    <div class="grid-2">
      <div class="panel"><h2>Teams</h2>${teamChart}${teamItems ? `<ol class="lb-list">${teamItems}</ol>` : '<div class="empty">Keine Teams</div>'}</div>
      <div class="panel"><h2>Spieler</h2>${playerItems ? `<ol class="lb-list">${playerItems}</ol>` : '<div class="empty">Noch keine Spieler – Karten werden beim ersten Scan automatisch angelegt.</div>'}</div>
    </div>`;
  animateTeamChart(tab, previousChart, "leaderboard");
}

// Vertical bar chart of the team scores (ranked order, colour = team colour).
// `key` separates the animation state of charts on different pages.
function teamChartHtml(teams, key) {
  if (!teams.length) return "";
  const maxT = Math.max(1, ...teams.map((t) => t.points));
  const shownValues = chartAnimValues(key);
  return `<div class="team-chart" role="img" aria-label="Punkte pro Team: ${esc(teams.map((t) => `${t.name} ${t.points}`).join(", "))}">
    ${teams
      .map(
        (t) => `<div class="tc-col" data-team="${t.id}" data-points="${t.points}" title="${esc(t.name)}: ${fmtNum(t.points)} Punkte · ${t.members} Spieler">
          <div class="tc-plot">
            <div class="tc-value">${fmtNum(shownValues.get(String(t.id)) ?? t.points)}</div>
            <div class="tc-bar" style="height:${((t.points / maxT) * TC_MAX_BAR_PX).toFixed(1)}px;background:${esc(t.color)}"></div>
          </div>
          <div class="tc-label">${esc(t.name)}</div>
        </div>`,
      )
      .join("")}
  </div>`;
}

// --- team chart animation -------------------------------------------------
// Bars grow from their previous height (from 0 when the chart appears), the
// value counts up, columns slide to their new rank (FLIP) and a team that just
// scored flashes briefly. Disabled with "reduce motion".

const TC_MAX_BAR_PX = 140;
const chartAnim = new Map(); // chart key -> Map(team id -> last shown points)

function chartAnimValues(key) {
  if (!chartAnim.has(key)) chartAnim.set(key, new Map());
  return chartAnim.get(key);
}

const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function captureTeamChart(root) {
  const prev = new Map();
  root.querySelectorAll(".team-chart .tc-col").forEach((col) => {
    const bar = col.querySelector(".tc-bar");
    prev.set(col.dataset.team, {
      left: col.getBoundingClientRect().left,
      height: bar.getBoundingClientRect().height,
    });
  });
  return prev;
}

function countUp(el, from, to, ms = 700) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = fmtNum(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function animateTeamChart(root, prev, key) {
  const reduce = reduceMotion();
  const values = chartAnimValues(key);
  root.querySelectorAll(".team-chart .tc-col").forEach((col) => {
    const id = col.dataset.team;
    const target = Number(col.dataset.points);
    const bar = col.querySelector(".tc-bar");
    const valueEl = col.querySelector(".tc-value");
    const shown = values.get(id);
    values.set(id, target);
    if (reduce) {
      valueEl.textContent = fmtNum(target);
      return;
    }
    const p = prev.get(id);
    const targetHeight = bar.style.height;

    // Start state: previous height and position, without transition.
    bar.style.transition = "none";
    bar.style.height = p ? `${p.height}px` : "0px";
    if (p) {
      const dx = p.left - col.getBoundingClientRect().left;
      if (Math.abs(dx) > 1) {
        col.style.transition = "none";
        col.style.transform = `translateX(${dx}px)`;
      }
    }
    // Next frame: animate to the new state.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        bar.style.transition = "";
        bar.style.height = targetHeight;
        col.style.transition = "transform 0.5s ease";
        col.style.transform = "";
      }),
    );
    if (shown !== undefined && shown !== target) countUp(valueEl, shown, target);
    if (shown !== undefined && target > shown) bar.classList.add("tc-up");
  });
}

// ---------------------------------------------------------------------------
// live transaction feed (monitoring page)
// ---------------------------------------------------------------------------

async function loadFeed() {
  state.feed = await api("GET", "/transactions?limit=60");
}

// Sticky panels start below the (sticky, possibly wrapping) top bar.
function updateTopbarHeight() {
  const h = $(".topbar")?.offsetHeight;
  if (h) document.documentElement.style.setProperty("--topbar-h", `${h}px`);
}
window.addEventListener("resize", updateTopbarHeight);
if (window.ResizeObserver) new ResizeObserver(updateTopbarHeight).observe(document.querySelector(".topbar"));

// Game events (state changes, game loaded/created) are stored in the
// transaction log with kind >= 100 and node_id 0.
// kind >= 110 are manual dashboard changes (audit log, own filter only).
const EVENT_KIND = {
  STATE: 100,
  LOADED: 101,
  CREATED: 102,
  NODE_OFFLINE: 103,
  NODE_ONLINE: 104,
  BRIDGE_CONNECTED: 105,
  BRIDGE_DISCONNECTED: 106,
  FLASHED: 107,
  NODE_STATE: 108,
  STATE_CONFIRMED: 109,
};
const isEvent = (t) => t.kind >= 100;
const isManual = (t) => t.kind >= 110;
const isLookup = (t) => t.kind === 2; // balance lookup at a Kontostand-Station

function stateBadge(st) {
  const cls = {0: "info", 1: "ok", 2: "warn", 3: "bad"}[st] ?? "";
  return `<span class="badge ${cls}">${GAME_STATE_LABELS[st] ?? "?"}</span>`;
}

function eventText(t) {
  let n = {};
  try {
    n = JSON.parse(t.note || "{}");
  } catch {
    // malformed note: show the generic text
  }
  if (isManual(t)) return esc(n.text || "Manuelle Änderung");
  if (t.kind === EVENT_KIND.STATE) return `Spielstatus ${stateBadge(n.from)} → ${stateBadge(n.to)}${n.reason ? ` – ${esc(n.reason)}` : ""}`;
  if (t.kind === EVENT_KIND.LOADED) {
    return `Spiel geladen${n.from !== n.to && n.from !== undefined ? ` (${stateBadge(n.from)} → ${stateBadge(n.to)})` : ` – ${stateBadge(n.to)}`}`;
  }
  if (t.kind === EVENT_KIND.CREATED) return `Spiel angelegt – ${stateBadge(n.to ?? 0)}`;
  if (t.kind === EVENT_KIND.NODE_OFFLINE) return `<span class="badge bad">Offline</span> ${esc(n.text || "Station scheint offline")}`;
  if (t.kind === EVENT_KIND.NODE_ONLINE) return `<span class="badge ok">Online</span> ${esc(n.text || "Station wieder erreichbar")}`;
  if (t.kind === EVENT_KIND.BRIDGE_CONNECTED) return `<span class="badge ok">Bridge</span> ${esc(n.text || "Bridge-Station verbunden")}`;
  if (t.kind === EVENT_KIND.BRIDGE_DISCONNECTED) return `<span class="badge bad">Bridge</span> ${esc(n.text || "Bridge-Station getrennt")}`;
  if (t.kind === EVENT_KIND.NODE_STATE) return `${stateBadge(n.state)} ${esc(n.text || "Station hat den Spielstatus übernommen")}`;
  if (t.kind === EVENT_KIND.STATE_CONFIRMED) return `${stateBadge(n.state)} ${esc(n.text || "Spielstatus von allen Stationen bestätigt")}`;
  if (t.kind === EVENT_KIND.FLASHED) {
    const cls = n.ok ? "ok" : n.state === "cancelled" ? "warn" : "bad";
    return `<span class="badge ${cls}">Firmware</span> ${esc(n.text || "ESP geflasht")}`;
  }
  return esc(n.text || "Spielereignis");
}

function feedItem(t) {
  if (isEvent(t)) {
    return `<li class="feed-item event ${state.newTxIds.has(t.id) ? "new-row" : ""}">
      <div class="row"><span class="small muted">${fmtTime(t.received_at)}</span><span class="spacer"></span><span class="small muted">Spielereignis</span></div>
      <div class="small">${eventText(t)}</div>
    </li>`;
  }
  const team = teamById(t.player_team);
  const outcome =
    (isLookup(t) ? '<span class="badge info">Kontoabfrage</span> ' : "") +
    (t.result === 0 ? `<strong class="${t.delta < 0 ? "neg" : "pos"}">${t.delta ? fmtSigned(t.delta) : "±0"}</strong>` : resultBadge(t.result));
  return `<li class="feed-item ${state.newTxIds.has(t.id) ? "new-row" : ""}">
    <div class="row"><span class="small muted">${fmtTime(t.node_time ? t.node_time * 1000 : t.received_at)}</span><span class="spacer"></span>${outcome}</div>
    <div class="player">${team ? `<span class="dot" style="background:${esc(team.color)}"></span>` : ""}<span class="player-link" data-player="${esc(t.uid)}" title="Spieler bearbeiten">${esc(t.player_name || t.uid)}</span></div>
    <div class="small muted">${esc(t.node_name || "?")} · Stand ${fmtNum(t.balance_after)}${t.adj_delta ? ` · Korrektur ${fmtSigned(t.adj_delta)}` : ""}</div>
  </li>`;
}

// ---------------------------------------------------------------------------
// tab: players
// ---------------------------------------------------------------------------

function renderPlayers() {
  const search = state.playerSearch.toLowerCase();
  const list = state.players.filter((p) => {
    if (state.playerTeamFilter !== "" && p.team_id !== Number(state.playerTeamFilter)) return false;
    return !search || p.name.toLowerCase().includes(search) || p.uid.toLowerCase().includes(search);
  });

  const rows = list
    .map(
      (p) => `<tr>
        <td><span class="player-link" data-player="${esc(p.uid)}" title="Spieler bearbeiten">${esc(p.name)}</span>${p.notes ? `<div class="small muted">${esc(p.notes)}</div>` : ""}</td>
        <td class="mono">${esc(p.uid)}</td>
        <td>${teamChip(p.team_id)}</td>
        <td class="num"><strong>${fmtNum(p.points)}</strong>${p.pending_count ? `<div class="small"><span class="badge warn" title="Wird beim nächsten Scan auf die Karte geschrieben">Ausstehend ${fmtSigned(p.pending_delta)}</span></div>` : ""}</td>
        <td class="num">${fmtNum(p.tap_count)}</td>
        <td class="small muted">${fmtAgo(p.last_seen)}</td>
      </tr>`,
    )
    .join("");

  $("#tab-players").innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input type="search" id="player-search" placeholder="Name oder UID suchen…" value="${esc(state.playerSearch)}">
        <select id="player-team-filter">
          <option value="">Alle Teams</option>
          ${state.teams.map((t) => `<option value="${t.id}" ${state.playerTeamFilter === String(t.id) ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select>
        <span class="spacer"></span>
        <span class="muted small">${list.length} von ${state.players.length} Spielern · neue Spieler kommen automatisch ins kleinste Team</span>
      </div>
      ${
        list.length
          ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Karten-UID</th><th>Team</th><th class="num">Punkte</th><th class="num">Scans</th><th>Zuletzt</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
          : '<div class="empty">Keine Spieler gefunden.</div>'
      }
    </div>`;

  const searchEl = $("#player-search");
  searchEl.oninput = debounce(() => {
    state.playerSearch = searchEl.value;
    renderPlayers();
    const el = $("#player-search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, 200);
  $("#player-team-filter").onchange = (e) => {
    state.playerTeamFilter = e.target.value;
    renderPlayers();
  };
}

async function openPlayerModal(uid) {
  let detail;
  try {
    detail = await api("GET", `/players/${encodeURIComponent(uid)}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const p = detail.player;
  // "Anpassungen": point corrections and team changes (written to the card on
  // the next scan) plus name changes (dashboard only), newest first.
  const adjRows = [
    ...detail.adjustments.map((a) => ({
      at: a.created_at,
      html: `<tr>
        <td class="small">${fmtDateTime(a.created_at)}</td>
        <td class="num">${a.delta ? fmtSigned(a.delta) : ""}${a.team_id !== null ? ` ${teamChip(a.team_id)}` : ""}</td>
        <td class="small">${esc(a.reason)}</td>
        <td>${a.applied_at ? `<span class="badge ok" title="${fmtDateTime(a.applied_at)}">Übernommen</span>` : '<span class="badge warn">Ausstehend</span>'}</td>
      </tr>`,
    })),
    ...(detail.nameChanges || []).map((c) => ({
      at: c.at,
      html: `<tr>
        <td class="small">${fmtDateTime(c.at)}</td>
        <td class="small">${esc(c.from)} → <strong>${esc(c.to)}</strong></td>
        <td class="small">Name geändert</td>
        <td><span class="badge info" title="Der Name wird nur auf dem Server gespeichert, nicht auf der Karte">Nur Server</span></td>
      </tr>`,
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .map((r) => r.html)
    .join("");

  openModal(`
    <h2>Spieler bearbeiten</h2>
    <p class="muted small">Karte <span class="mono">${esc(p.uid)}</span> · zuerst gesehen ${fmtDateTime(p.first_seen)}</p>
    <label class="field">Name<input type="text" id="pm-name" value="${esc(p.name)}" maxlength="60"></label>
    <label class="field">Team
      <select id="pm-team">
        ${state.teams.map((t) => `<option value="${t.id}" ${p.team_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>
      <span class="hint">Die Teamfarbe wird beim nächsten Scan auf die Karte geschrieben.</span>
    </label>
    <label class="field">Notizen<textarea id="pm-notes" maxlength="500">${esc(p.notes)}</textarea></label>
    <div class="modal-actions" style="margin-top:0"><button class="btn primary" id="pm-save">Speichern</button></div>

    <h3>Punkte korrigieren</h3>
    <p class="small muted">Aktuell auf der Karte: <strong>${fmtNum(p.points)}</strong>${p.pending_count ? ` · ausstehend: <strong>${fmtSigned(p.pending_delta)}</strong>` : ""}.
      Korrekturen werden beim nächsten Scan an einer beliebigen Station auf die Karte geschrieben. Der Stand kann nie unter 0 fallen.</p>
    <div class="row">
      <select id="pm-mode"><option value="delta">Punkte ändern um</option><option value="set">Punkte setzen auf</option></select>
      <input type="number" id="pm-value" style="width:120px" placeholder="z. B. 50">
      <input type="text" id="pm-reason" placeholder="Grund (optional)" style="flex:1;min-width:140px">
    </div>
    <div class="modal-actions" style="margin-top:12px"><button class="btn primary" id="pm-adjust">Korrektur anlegen</button></div>
    ${adjRows ? `<h3>Anpassungen</h3><div class="table-wrap"><table><tbody>${adjRows}</tbody></table></div>` : ""}
    <div class="modal-actions">
      <button class="btn" id="pm-tx">Transaktionen anzeigen</button>
      <button class="btn" data-close>Schließen</button>
    </div>`);

  $("#pm-save").onclick = () =>
    run(async () => {
      const team = $("#pm-team").value;
      await api("PATCH", `/players/${encodeURIComponent(uid)}`, {
        name: $("#pm-name").value,
        teamId: team === "" ? null : Number(team),
        notes: $("#pm-notes").value,
      });
      closeModal();
    }, "Spieler gespeichert");

  $("#pm-adjust").onclick = () =>
    run(async () => {
      const v = $("#pm-value").value.trim();
      if (v === "") throw new Error("Bitte einen Wert eingeben");
      const body = {reason: $("#pm-reason").value};
      if ($("#pm-mode").value === "set") body.setTo = Number(v);
      else body.delta = Number(v);
      await api("POST", `/players/${encodeURIComponent(uid)}/adjust`, body);
      await loadPlayers();
      openPlayerModal(uid);
    }, "Korrektur angelegt – wird beim nächsten Scan übernommen");

  $("#pm-tx").onclick = () => {
    closeModal();
    state.txFilter = {uid, node: "", result: ""};
    switchTab("transactions");
  };
}

// ---------------------------------------------------------------------------
// tab: transactions
// ---------------------------------------------------------------------------

function txRow(t) {
  if (isEvent(t)) {
    const manual = isManual(t);
    return `<tr class="${manual ? "manual-row" : "event-row"} ${state.newTxIds.has(t.id) ? "new-row" : ""}">
      <td class="small" title="${fmtDateTime(t.received_at)}">${fmtTime(t.received_at)}</td>
      <td colspan="8">${manual ? '<span class="badge warn">Manuell</span>' : '<span class="badge info">Spielereignis</span>'} ${eventText(t)}</td>
    </tr>`;
  }
  const flags = [];
  if (!(t.flags & TX_FLAGS.VERIFIED) && (t.result === 0 || t.adj_delta)) flags.push('<span title="Schreiben nicht verifiziert (Karte zu früh entfernt?)">⚠️</span>');
  if (t.flags & TX_FLAGS.FRESH_CARD) flags.push('<span title="Neue/leere Karte oder Karte aus altem Spiel">🆕</span>');
  if (t.flags & TX_FLAGS.SINGLE_SLOT) flags.push('<span title="Karte hat nur einen Speicherplatz (nicht abrissfest)">①</span>');
  const delayed = t.node_time && t.received_at / 1000 - t.node_time > 20;
  if (delayed) flags.push(`<span title="Verzögert übertragen (Station war offline). Scan um ${fmtTime(t.node_time * 1000)}">📶</span>`);
  return `<tr class="${state.newTxIds.has(t.id) ? "new-row" : ""}">
    <td class="small">${fmtTime(t.node_time ? t.node_time * 1000 : t.received_at)}</td>
    <td>${esc(t.node_name || t.node_id.toString(16))}</td>
    <td><span class="player-link" data-player="${esc(t.uid)}" title="Spieler bearbeiten">${esc(t.player_name || t.uid)}</span></td>
    <td>${teamChip(t.player_team)}</td>
    <td>${isLookup(t) ? '<span class="badge info">Kontoabfrage</span> ' : ""}${resultBadge(t.result)}</td>
    <td class="num">${t.delta ? fmtSigned(t.delta) : ""}</td>
    <td class="num">${t.adj_delta ? fmtSigned(t.adj_delta) : ""}</td>
    <td class="num">${fmtNum(t.balance_before)} → <strong>${fmtNum(t.balance_after)}</strong></td>
    <td>${flags.join(" ")}</td>
  </tr>`;
}

function renderTransactions() {
  const f = state.txFilter;
  const playerName = f.uid ? state.players.find((p) => p.uid === f.uid)?.name || f.uid : "";
  $("#tab-transactions").innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <select id="tx-node"><option value="">Alle Stationen</option>
          ${state.nodes.map((n) => `<option value="${n.nodeId}" ${String(n.nodeId) === String(f.node) ? "selected" : ""}>${esc(n.name)}</option>`).join("")}
        </select>
        <select id="tx-result"><option value="">Alle Ergebnisse</option>
          ${Object.entries(RESULT_LABELS)
            .map(([k, [l]]) => `<option value="${k}" ${String(f.result) === k ? "selected" : ""}>${l}</option>`)
            .join("")}
          <option value="event" ${f.result === "event" ? "selected" : ""}>Spielereignisse</option>
          <option value="manual" ${f.result === "manual" ? "selected" : ""}>Manuelle Änderungen</option>
        </select>
        ${f.uid ? `<span class="badge info">Spieler: ${esc(playerName)} <a href="#" id="tx-clear-uid" title="Filter entfernen">✕</a></span>` : ""}
        <span class="spacer"></span>
        <a class="btn small" href="/api/transactions.csv" download>CSV-Export</a>
      </div>
      ${
        state.txs.length
          ? `<div class="table-wrap"><table>
        <thead><tr><th>Zeit</th><th>Station</th><th>Spieler</th><th>Team</th><th>Ergebnis</th><th class="num">Punkte</th><th class="num">Korrektur</th><th class="num">Stand</th><th></th></tr></thead>
        <tbody>${state.txs.map(txRow).join("")}</tbody></table></div>
        ${state.txHasMore ? '<div class="row" style="justify-content:center;margin-top:12px"><button class="btn" id="tx-more">Ältere laden</button></div>' : ""}`
          : '<div class="empty">Noch keine Transaktionen.</div>'
      }
    </div>`;

  $("#tx-node").onchange = (e) => {
    state.txFilter.node = e.target.value;
    refreshTransactions();
  };
  $("#tx-result").onchange = (e) => {
    state.txFilter.result = e.target.value;
    refreshTransactions();
  };
  const clear = $("#tx-clear-uid");
  if (clear) {
    clear.onclick = (e) => {
      e.preventDefault();
      state.txFilter.uid = "";
      refreshTransactions();
    };
  }
  const more = $("#tx-more");
  if (more)
    more.onclick = () =>
      run(async () => {
        await loadTransactions(true);
        renderTransactions();
      });
}

function refreshTransactions() {
  run(async () => {
    await loadTransactions();
    renderTransactions();
  });
}

function txMatchesFilter(t) {
  const f = state.txFilter;
  if (isManual(t)) return !f.uid && !f.node && f.result === "manual";
  if (isEvent(t)) return !f.uid && !f.node && (f.result === "" || f.result === "event");
  if (f.result === "event" || f.result === "manual") return false;
  if (f.uid && t.uid !== f.uid) return false;
  if (f.node && String(t.node_id) !== String(f.node)) return false;
  if (f.result !== "" && String(t.result) !== String(f.result)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// tab: nodes
// ---------------------------------------------------------------------------

function nodeConfigSummary(n) {
  const type = state.nodeTypes.find((t) => t.id === n.nodeType);
  const parts = [];
  if (type) {
    for (const f of type.fields) parts.push(`${f.label}: <strong>${esc(n.typeConfig[f.key] ?? f.default)}</strong>`);
  }
  if (type && type.usesCooldown === false) {
    parts.push(`Kosten pro Abfrage: <strong>${state.settings?.lookupCost ?? 0} Punkte</strong> (Spieleinstellungen)`);
  } else {
    parts.push(`Abklingzeit: <strong>${state.settings?.defaultCooldownSec ?? "?"} s</strong>`);
  }
  return parts.join(" · ");
}

function syncBadge(n) {
  if (!n.inSync) return '<span class="badge">Unbekannt</span>';
  const gs = reportedGameState(n);
  const stateHtml =
    gs === null ? "" : `<div class="small muted" style="margin-top:4px" title="Von der Station gemeldeter Spielstatus">${stateBadge(gs)}${stateAcked(n) ? " bestätigt" : " ⟳ wird übertragen"}</div>`;
  return syncBadgeInner(n) + stateHtml;
}

function syncBadgeInner(n) {
  const missing = [];
  if (!n.inSync.game) missing.push("Spiel");
  if (!n.inSync.node) missing.push("Station");
  if (!n.inSync.adj) missing.push("Korrekturen");
  return missing.length ? `<span class="badge warn" title="Wird automatisch erneut gesendet">⟳ ${missing.join(", ")}</span>` : '<span class="badge ok">Aktuell</span>';
}

// ---------------------------------------------------------------------------
// topology map (Stationen tab)
// ---------------------------------------------------------------------------
// Vertices: bridge node + stations. Edges: radio links reported in the
// heartbeats (each device lists whom it hears directly, in frames/minute).
// Layout: bridge in the centre, stations on rings by hop count; positions can
// be dragged and are stored in this browser (localStorage).

const TOPO_W = 1000;
const TOPO_H = 560;
const TOPO_CX = TOPO_W / 2;
const TOPO_CY = TOPO_H / 2;
const topo = {positions: loadTopoPositions(), drag: null, current: null, showFallback: loadShowFallback()};

// "Ausweichrouten": radio links that are not the chosen route of a station.
// Shown by default; the choice is remembered in this browser.
function loadShowFallback() {
  try {
    return localStorage.getItem("fk-topo-fallback") !== "0";
  } catch {
    return true;
  }
}

function attachFallbackToggle(root) {
  root.querySelectorAll("[data-topo-fallback]").forEach((cb) => {
    cb.onchange = () => {
      topo.showFallback = cb.checked;
      try {
        localStorage.setItem("fk-topo-fallback", cb.checked ? "1" : "0");
      } catch {
        // storage unavailable: setting lasts for this page only
      }
      document.querySelectorAll("[data-topo-fallback]").forEach((other) => (other.checked = cb.checked));
      document.querySelectorAll(".topo").forEach((el) => el.classList.toggle("hide-fallback", !cb.checked));
    };
  });
}

function resetTopoLayout() {
  topo.positions = {};
  saveTopoPositions();
  if ($("#mon-topo")) renderTopology($("#mon-topo"), $("#mon-topo-hint"));
  if ($("#topo")) renderTopology($("#topo"), $("#topo-hint"));
}

function loadTopoPositions() {
  try {
    return JSON.parse(localStorage.getItem("fk-topo-pos") || "{}");
  } catch {
    return {};
  }
}

function saveTopoPositions() {
  try {
    localStorage.setItem("fk-topo-pos", JSON.stringify(topo.positions));
  } catch {
    // storage unavailable: positions only last for this page view
  }
}

// Link colour: measured link quality (% of beacon rounds heard) if known,
// otherwise frames per minute.
const COST_PER_LINK = 5; // route cost unit: 1.0 ETX = 5 (see firmware Protocol.h)
const linkClass = (e) => {
  const qs = [e.qab, e.qba].filter((q) => q !== null);
  if (qs.length) {
    const q = Math.min(...qs);
    return q >= 80 ? "good" : q >= 50 ? "mid" : "weak";
  }
  const rate = Math.max(e.ab ?? 0, e.ba ?? 0);
  return rate >= 20 ? "good" : rate >= 5 ? "mid" : "weak";
};

// Game state a station reports in its heartbeat (null = unknown / no config).
function reportedGameState(n) {
  const gs = n.status?.gameState;
  return gs === undefined || gs === 255 ? null : gs;
}

// Station applies the game state of the active game.
function stateAcked(n) {
  const s = state.settings;
  return Boolean(s) && reportedGameState(n) === s.state && n.status?.gameId === s.gameId;
}

function buildTopology() {
  const g = state.gateway || {};
  const bridgeId = g.gateway?.id !== undefined ? g.gateway.id >>> 0 : null;
  const vertices = new Map();
  vertices.set("bridge", {key: "bridge", name: "Bridge-Station", bridge: true, online: Boolean(g.connected), dist: 0, queue: g.gateway?.ql || 0});
  for (const n of state.nodes) {
    const d = n.status?.dist;
    vertices.set(String(n.nodeId), {
      key: String(n.nodeId),
      hexId: n.hexId,
      nodeId: n.nodeId,
      letter: state.nodeTypes.find((t) => t.id === n.nodeType)?.letter ?? "?",
      typeLabel: n.nodeTypeLabel,
      name: n.name,
      online: n.online,
      dist: n.online && d !== undefined && d !== 255 ? d : null,
      cost: n.online && n.status?.cost !== undefined && n.status.cost < 255 ? n.status.cost / COST_PER_LINK : null,
      parent: n.online && n.status?.parent ? n.status.parent >>> 0 : null,
      queue: n.status?.queueLen || 0,
      gameState: reportedGameState(n),
      stateAcked: stateAcked(n),
    });
  }
  const keyOf = (id) => {
    const u = id >>> 0;
    if (u === bridgeId) return "bridge";
    return vertices.has(String(u)) ? String(u) : null;
  };
  // Each device reports what it hears: frames per minute and link quality
  // (% of beacon rounds heard). ab = heard by b from a's side as reported by a.
  const edges = new Map();
  const addDirected = (from, to, rate, quality) => {
    if (!to || from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const k = `${a}|${b}`;
    const e = edges.get(k) || {a, b, ab: null, ba: null, qab: null, qba: null, route: false};
    const q = quality === undefined || quality === 255 ? null : quality;
    if (from === a) {
      e.ab = rate;
      e.qab = q;
    } else {
      e.ba = rate;
      e.qba = q;
    }
    edges.set(k, e);
  };
  for (const n of state.nodes) {
    if (!n.online) continue;
    for (const nb of n.status?.neighbors || []) addDirected(String(n.nodeId), keyOf(nb.id), nb.perMin, nb.quality);
  }
  if (g.connected) {
    for (const [id, rate, quality] of g.gateway?.nb || []) addDirected("bridge", keyOf(id), rate, quality);
  }
  // Links the stations chose as their route (station -> parent).
  for (const v of vertices.values()) {
    if (v.bridge || v.parent === null) continue;
    const pk = keyOf(v.parent);
    if (!pk) continue;
    v.parentKey = pk;
    const [a, b] = v.key < pk ? [v.key, pk] : [pk, v.key];
    const e = edges.get(`${a}|${b}`);
    if (e) e.route = true;
  }
  return {vertices, edges: [...edges.values()]};
}

// Rings by hop count; within a ring, stations are ordered by the angle of their
// neighbours on the inner ring to reduce crossing lines.
function autoLayout(vertices, edges) {
  const pos = {bridge: [TOPO_CX, TOPO_CY]};
  const known = [...vertices.values()].filter((v) => !v.bridge && v.dist !== null).map((v) => v.dist);
  const maxDist = Math.max(1, ...known);
  const rings = new Map();
  for (const v of vertices.values()) {
    if (v.bridge) continue;
    const d = v.dist ?? maxDist + 1; // offline / unreachable: outer ring
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d).push(v);
  }
  const ringCount = Math.max(1, ...rings.keys());
  const rx = (TOPO_W / 2 - 80) / ringCount;
  const ry = (TOPO_H / 2 - 45) / ringCount;
  const angleOf = {};
  const neighboursOf = (key) => edges.filter((e) => e.a === key || e.b === key).map((e) => (e.a === key ? e.b : e.a));
  const circularMean = (angles) =>
    Math.atan2(
      angles.reduce((s, a) => s + Math.sin(a), 0),
      angles.reduce((s, a) => s + Math.cos(a), 0),
    );

  for (const d of [...rings.keys()].sort((a, b) => a - b)) {
    const list = rings.get(d).map((v) => {
      const inner = neighboursOf(v.key).filter((k) => angleOf[k] !== undefined);
      return {v, pref: inner.length ? circularMean(inner.map((k) => angleOf[k])) : null};
    });
    list.sort((p, q) => (p.pref ?? 10) - (q.pref ?? 10) || p.v.name.localeCompare(q.v.name));
    const step = (2 * Math.PI) / list.length;
    const offsets = list.filter((p) => p.pref !== null).map((p) => p.pref - list.indexOf(p) * step);
    const offset = offsets.length ? circularMean(offsets) : -Math.PI / 2;
    list.forEach((p, i) => {
      const a = offset + i * step;
      angleOf[p.v.key] = a;
      pos[p.v.key] = [TOPO_CX + Math.cos(a) * rx * d, TOPO_CY + Math.sin(a) * ry * d];
    });
  }
  return {pos, rx, ry, ringCount};
}

// el: container for the map SVG; hintEl: optional element for the "no link
// data" hint (kept outside the map so overlays stay aligned with the SVG).
function renderTopology(el, hintEl) {
  if (!el) return;
  const {vertices, edges} = buildTopology();
  const layout = autoLayout(vertices, edges);
  const storeKey = (k) => (k === "bridge" ? "bridge" : vertices.get(k).hexId);
  const posOf = (k) => topo.positions[storeKey(k)] || layout.pos[k];
  topo.current = {posOf, storeKey, vertices, edges};
  el.classList.toggle("hide-fallback", !topo.showFallback);

  const guides = Array.from({length: layout.ringCount}, (_, i) => i + 1)
    .map((d) => `<ellipse class="topo-ring" cx="${TOPO_CX}" cy="${TOPO_CY}" rx="${layout.rx * d}" ry="${layout.ry * d}"></ellipse>`)
    .join("");

  const lines = edges
    .map((e) => {
      const oneWay = e.ab === null || e.ba === null;
      // ab/qab: reported by a about what it hears from b (and vice versa).
      const na = vertices.get(e.a).name;
      const nb = vertices.get(e.b).name;
      const side = (listener, speaker, q, rate) =>
        q === null && rate === null
          ? `${listener} hört ${speaker} nicht`
          : `${listener} hört ${speaker}: ${q === null ? "Qualität unbekannt" : `${q} % der Beacons`}` + `${rate === null ? "" : ` · ${rate} Pakete/min`}`;
      const tip = `${na} ↔ ${nb}${e.route ? " (genutzte Route)" : ""}\n` + `${side(na, nb, e.qab, e.ab)}\n${side(nb, na, e.qba, e.ba)}`;
      return `<path class="topo-link ${linkClass(e)}${oneWay ? " oneway" : ""}${e.route ? " route" : ""}" data-a="${e.a}" data-b="${e.b}"
        d="${linkPath(e.a, e.b, posOf(e.a), posOf(e.b))}"><title>${esc(tip)}</title></path>`;
    })
    .join("");

  const nodes = [...vertices.values()]
    .map((v) => {
      const [x, y] = posOf(v.key);
      const gsCls = v.gameState === null ? "gs-none" : `gs-${v.gameState}`;
      const cls = v.bridge ? "bridge" : !v.online ? `offline ${gsCls}` : v.dist === null ? `lost ${gsCls}` : `online ${gsCls}`;
      const stateTip =
        v.gameState === null
          ? "Spielstatus unbekannt"
          : `Spielstatus: ${GAME_STATE_LABELS[v.gameState]}${v.stateAcked ? "" : ` (soll: ${GAME_STATE_LABELS[state.settings?.state] ?? "?"}, wird übertragen)`}`;
      const tip = v.bridge
        ? `Bridge-Station (USB)${v.online ? "" : " – nicht verbunden"}`
        : `${v.name} (${v.hexId}) · ${v.typeLabel}\n${v.online ? (v.dist === null ? "kein Weg zur Bridge-Station" : `${v.dist} Hop(s) zur Bridge-Station${v.cost !== null ? `, Routenkosten ${v.cost.toFixed(1)}` : ""}${v.parentKey ? ` über ${vertices.get(v.parentKey)?.name ?? "?"}` : ""}`) : "offline – zuletzt gemeldet:"}` +
          `\n${stateTip}${v.queue ? `\n${v.queue} Transaktionen im Puffer` : ""}\nKlicken: Einstellungen · Ziehen: verschieben`;
      return `<g class="topo-node ${cls}" data-key="${v.key}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
        ${v.bridge ? '<circle class="halo" r="22"></circle>' : ""}
        ${v.queue ? '<circle class="queue" r="19"></circle>' : ""}
        <circle class="dot" r="${v.bridge ? 17 : 13}"></circle>
        <text class="hop" y="4">${v.bridge ? "B" : esc(v.letter)}</text>
        <text class="name" y="${v.bridge ? 33 : 29}">${esc(v.name)}</text>
        <title>${esc(tip)}</title>
      </g>`;
    })
    .join("");

  // No link data although stations are online: server or firmware too old.
  const onlineCount = [...vertices.values()].filter((v) => !v.bridge && v.online).length;
  if (hintEl) {
    hintEl.innerHTML =
      !edges.length && onlineCount
        ? `<div class="callout small">Keine Funkverbindungsdaten vorhanden. Die Stationen melden ihre Nachbarn erst mit
            aktueller Firmware; nach einem Update des Servers diesen bitte neu starten. Daten kommen mit dem nächsten Heartbeat (bis 20 s).</div>`
        : "";
  }
  // Pulse layer sits between links and stations, so animations never cover a
  // station or its name. It is moved into the new SVG on every redraw, which
  // keeps running animations alive.
  const pulseLayer = el.querySelector(".pulse-layer") || svgEl("g", {class: "pulse-layer"});
  el.innerHTML = `<svg class="topo-svg" viewBox="0 0 ${TOPO_W} ${TOPO_H}" role="img" aria-label="Funknetz der Stationen">
    ${guides}${lines}<g class="pulse-slot"></g>${nodes}</svg>`;
  el.querySelector(".pulse-slot").replaceWith(pulseLayer);
  addLabelBackgrounds(el.querySelector("svg"));
  attachTopoDrag(el.querySelector("svg"));
}

// Link geometry. Links to the bridge node are straight; links between two
// stations bow slightly to one side. Otherwise links of stations on opposite
// sides of a ring would run exactly through the bridge node (or other
// stations) and lie on top of each other.
const LINK_CURVE = 0.16;

function linkControl(ka, kb, pa, pb) {
  if (ka === "bridge" || kb === "bridge") return null;
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  // The side depends on the key order, so a link bends the same way no matter
  // in which direction it is drawn or travelled.
  const side = ka < kb ? 1 : -1;
  return [(pa[0] + pb[0]) / 2 - dy * LINK_CURVE * side, (pa[1] + pb[1]) / 2 + dx * LINK_CURVE * side];
}

function linkPath(ka, kb, pa, pb) {
  const c = linkControl(ka, kb, pa, pb);
  const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  return c ? `M ${f(pa)} Q ${f(c)} ${f(pb)}` : `M ${f(pa)} L ${f(pb)}`;
}

function pointOnLink(ka, kb, pa, pb, t) {
  const c = linkControl(ka, kb, pa, pb);
  if (!c) return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  const u = 1 - t;
  return [u * u * pa[0] + 2 * u * t * c[0] + t * t * pb[0], u * u * pa[1] + 2 * u * t * c[1] + t * t * pb[1]];
}

// Solid box behind every station name, so radio links running under a label
// cannot show through between the letters.
function addLabelBackgrounds(svg) {
  svg.querySelectorAll(".topo-node text.name").forEach((text) => {
    let box;
    try {
      box = text.getBBox();
    } catch {
      return;
    }
    if (!box.width) return; // map not visible (hidden tab): keep the text halo only
    text.parentNode.insertBefore(
      svgEl("rect", {
        class: "label-bg",
        x: (box.x - 5).toFixed(1),
        y: (box.y - 2).toFixed(1),
        width: (box.width + 10).toFixed(1),
        height: (box.height + 4).toFixed(1),
        rx: 5,
      }),
      text,
    );
  });
}

function topoLegendHtml() {
  return `<span class="small muted topo-legend">
    <span class="legend-dot bridge"></span>Bridge
    <span class="legend-dot gs-0"></span>Vorbereitung
    <span class="legend-dot gs-1"></span>Läuft
    <span class="legend-dot gs-2"></span>Pausiert
    <span class="legend-dot gs-3"></span>Beendet
    <span class="legend-dot offline"></span>Offline
    <span class="legend-line route"></span>genutzte Route
    <span class="legend-line good"></span>gut (≥ 80 %)
    <span class="legend-line mid"></span>mittel
    <span class="legend-line weak"></span>schwach (&lt; 50 %)
    <span class="legend-line oneway"></span>nur einseitig
  </span>`;
}

// --- transaction pulse ------------------------------------------------------
// Radio traffic on the monitoring map: dots travel along the radio route (hop
// by hop via the best neighbour closer to the bridge), the links keep their
// connection quality colour.
//   card transaction     station -> bridge, player's team colour
//   everything else (game config, station config, correction list,
//   commands bridge -> station(s); state confirmations station -> bridge): grey
// Drawn in the map's pulse layer (between links and stations), which is
// carried over on every map redraw so running animations are not interrupted.

const PULSE_MS_PER_HOP = 420;

function routeToBridge(startKey) {
  const cur = topo.current;
  if (!cur || !cur.vertices.has(startKey)) return null;
  // The route each station reports (parent chain), if complete.
  const chain = [startKey];
  for (let k = startKey; k !== "bridge" && chain.length < 16; ) {
    k = cur.vertices.get(k)?.parentKey;
    if (!k || chain.includes(k)) break;
    chain.push(k);
  }
  if (chain[chain.length - 1] === "bridge") return chain;
  // Otherwise: best guess from the neighbour data.
  const path = [startKey];
  const visited = new Set(path);
  let key = startKey;
  while (key !== "bridge" && path.length < 12) {
    const here = cur.vertices.get(key);
    const options = cur.edges
      .filter((e) => e.a === key || e.b === key)
      .map((e) => ({next: e.a === key ? e.b : e.a, rate: Math.max(e.ab ?? 0, e.ba ?? 0)}))
      .filter((o) => !visited.has(o.next))
      .map((o) => ({...o, dist: cur.vertices.get(o.next)?.dist ?? 99}));
    if (!options.length) break;
    // Prefer neighbours closer to the bridge, then the strongest link.
    const closer = options.filter((o) => here?.dist === null || here?.dist === undefined || o.dist < here.dist);
    const pool = closer.length ? closer : options;
    pool.sort((a, b) => a.dist - b.dist || b.rate - a.rate);
    key = pool[0].next;
    path.push(key);
    visited.add(key);
  }
  return path;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const SYSTEM_DOT_COLOR = "var(--muted)"; // everything that is not a card scan
const MAX_BROADCAST_DOTS = 60;

function pulseTransaction(tx) {
  const overlay = $("#mon-topo .pulse-layer");
  if (state.tab !== "monitor" || !overlay || reduceMotion() || !topo.current) return;
  // Card scans only. State confirmations are heartbeats and are drawn as
  // such (pulseFrame).
  if (isEvent(tx)) return;
  const color = teamById(tx.player_team)?.color || "var(--muted)"; // grey without a team
  travelDot(overlay, routeToBridge(String(tx.node_id >>> 0)), color, tx.result !== 0 ? "var(--danger)" : color);
}

// Radio traffic reported by the bridge station (every frame it transmits) and
// by the server (every heartbeat received); card scans come via pulseTransaction.
//   bridge -> stations   beacon (every 5 s)               tiny dot to every station
//                        ACK batch (confirmed scans)      small dot to each confirmed station
//                        game/station config, correction list, command   normal dot
//   stations -> bridge   heartbeat                        small dot
//                        repeated scan (ACK was lost)     small dot
// All grey; only scans carry a team colour.
const RADIO_PKT = {BEACON: 1, RELIABLE: 2, ACK: 3, HEARTBEAT: 4, GAME_CONFIG: 5, NODE_CONFIG: 6, ADJ_CHUNK: 7, CMD: 8};
const HEARTBEAT_DOT_R = 4; // small dots, no arrival ripple
const BEACON_DOT_R = 2.5;

function pulseFrame(f) {
  const overlay = $("#mon-topo .pulse-layer");
  if (!f || state.tab !== "monitor" || !overlay || reduceMotion() || !topo.current) return;
  const toBridge = (id, r) => travelDot(overlay, routeToBridge(String(id >>> 0)), SYSTEM_DOT_COLOR, null, r);
  const toStation = (id, r) => travelDot(overlay, routeToBridge(String(id >>> 0))?.reverse(), SYSTEM_DOT_COLOR, null, r);
  if (f.d === "rx") {
    // heartbeat, or a repeated transaction
    if (f.node !== undefined) toBridge(f.node, HEARTBEAT_DOT_R);
    return;
  }
  if (f.pt === RADIO_PKT.BEACON) {
    broadcastDots(overlay, SYSTEM_DOT_COLOR, BEACON_DOT_R);
  } else if (f.pt === RADIO_PKT.ACK) {
    for (const id of new Set(f.n || [])) toStation(id, HEARTBEAT_DOT_R);
  } else if (f.dst === "all") {
    broadcastDots(overlay, SYSTEM_DOT_COLOR);
  } else if (f.dst !== undefined) {
    toStation(f.dst);
  }
}

// Bridge -> every online station (the mesh floods broadcasts to all).
function broadcastDots(overlay, color, radius = 7) {
  const keys = [...topo.current.vertices.values()].filter((v) => !v.bridge && v.online).map((v) => v.key);
  for (const key of keys.slice(0, MAX_BROADCAST_DOTS)) travelDot(overlay, routeToBridge(key)?.reverse(), color, null, radius);
}

// Moves a dot along `route` (vertex keys). rippleColor: optional ripple at the
// start (e.g. red for a rejected scan); every arrival flashes in `color`.
function travelDot(overlay, route, color, rippleColor = null, radius = 7) {
  if (!route || !route.length) return;
  // Positions are looked up on every frame (not once at the start), so dots
  // and ripples follow a station that is being dragged; the start positions
  // are the fallback if a station disappears from the map meanwhile.
  const start = route.map((k) => topo.current.posOf(k));
  const posAt = (i) => {
    try {
      return topo.current?.posOf(route[i]) || start[i];
    } catch {
      return start[i];
    }
  };
  const ripple = (i, r0, grow, ms, stroke) => {
    const c = svgEl("circle", {cx: posAt(i)[0], cy: posAt(i)[1], r: r0, class: "pulse-ripple", stroke});
    overlay.appendChild(c);
    animateFor(
      ms,
      (t) => {
        const [x, y] = posAt(i);
        c.setAttribute("cx", x.toFixed(1));
        c.setAttribute("cy", y.toFixed(1));
        c.setAttribute("r", (r0 + t * grow).toFixed(1));
        c.setAttribute("opacity", (1 - t).toFixed(2));
      },
      () => c.remove(),
    );
  };
  if (rippleColor) ripple(0, 14, 26, 900, rippleColor);
  if (route.length < 2) return;

  const dot = svgEl("circle", {r: radius, class: `pulse-dot${radius < 3 ? " tiny" : radius < 7 ? " small" : ""}`, fill: color, cx: start[0][0], cy: start[0][1]});
  overlay.appendChild(dot);
  const hops = route.length - 1;
  animateFor(
    hops * PULSE_MS_PER_HOP,
    (t) => {
      const pos = t * hops;
      const i = Math.min(hops - 1, Math.floor(pos));
      const [x, y] = pointOnLink(route[i], route[i + 1], posAt(i), posAt(i + 1), pos - i);
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));
    },
    () => {
      dot.remove();
      if (radius < 7) return;
      ripple(route.length - 1, route[route.length - 1] === "bridge" ? 18 : 14, 16, 600, color);
    },
  );
}

// Runs onFrame(t) with t from 0 to 1 over `ms`. onDone (cleanup) always runs,
// even if a frame throws, so no animation element is ever left behind.
function animateFor(ms, onFrame, onDone) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    try {
      onFrame(t);
    } catch {
      onDone?.();
      return;
    }
    if (t < 1) requestAnimationFrame(step);
    else onDone?.();
  };
  requestAnimationFrame(step);
}

function svgPoint(svg, e) {
  const p = svg.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

function attachTopoDrag(svg) {
  svg.querySelectorAll(".topo-node").forEach((g) => {
    const key = g.dataset.key;
    g.onpointerdown = (e) => {
      e.preventDefault();
      const p = svgPoint(svg, e);
      const [x, y] = topo.current.posOf(key);
      topo.drag = {key, dx: x - p.x, dy: y - p.y, sx: e.clientX, sy: e.clientY, moved: false};
      g.setPointerCapture(e.pointerId);
    };
    g.onpointermove = (e) => {
      const d = topo.drag;
      if (!d || d.key !== key) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const p = svgPoint(svg, e);
      const x = Math.max(20, Math.min(TOPO_W - 20, p.x + d.dx));
      const y = Math.max(20, Math.min(TOPO_H - 35, p.y + d.dy));
      topo.positions[topo.current.storeKey(key)] = [x, y];
      g.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      const posOf = topo.current.posOf;
      svg.querySelectorAll(`.topo-link[data-a="${key}"], .topo-link[data-b="${key}"]`).forEach((l) => {
        const {a, b} = l.dataset;
        l.setAttribute("d", linkPath(a, b, posOf(a), posOf(b)));
      });
    };
    const end = () => {
      const d = topo.drag;
      topo.drag = null;
      if (!d || d.key !== key) return;
      if (d.moved) saveTopoPositions();
      else if (key !== "bridge") openNodeModal(Number(key));
    };
    g.onpointerup = end;
    g.onpointercancel = () => {
      topo.drag = null;
      saveTopoPositions();
    };
  });
}

// The bridge node (USB gateway) is shown as the first row of the station list.
function bridgeRow() {
  const g = state.gateway || {};
  const gw = g.gateway || {};
  const fresh = g.connected && g.lastSeen && Date.now() - g.lastSeen < 15000;
  let status;
  if (!g.connected) status = '<span class="badge bad">Nicht verbunden</span>';
  else if (!fresh) status = '<span class="badge warn">Antwortet nicht</span>';
  else status = `<span class="badge ${g.simulated ? "warn" : "ok"}">${g.simulated ? "Simulation" : "Online"}</span>`;
  const id = gw.id !== undefined ? (gw.id >>> 0).toString(16).padStart(8, "0").toUpperCase() : "–";
  return `<tr>
    <td><strong>Bridge-Station</strong> <span class="badge info">USB</span>
      <div class="small muted mono">${esc(id)} · Verbindung zum PC${gw.fw !== undefined ? ` · Firmware ${esc(gw.fw)}` : ""}</div></td>
    <td>${status}<div class="small muted">${g.lastSeen ? fmtAgo(g.lastSeen) : ""}</div></td>
    <td class="small muted">–</td>
    <td class="small">${g.connected ? `Port <strong>${esc(g.path)}</strong>` : "Per USB anschließen"}</td>
    <td class="num">0</td>
    <td class="num" title="Nachrichten in der Bridge-Station, noch nicht in der Datenbank">${gw.ql ? `<span class="badge warn">${gw.ql}</span>` : g.connected ? "0" : "–"}</td>
    <td class="small">${gw.up !== undefined ? fmtDuration(gw.up) : "–"}</td>
    <td></td>
  </tr>`;
}

function renderNodes() {
  if (topo.drag) return; // don't rebuild the map while a station is being dragged
  const rows = state.nodes
    .map((n) => {
      const st = n.status || {};
      return `<tr>
        <td><strong>${esc(n.name)}</strong>${n.enabled ? "" : ' <span class="badge bad">Deaktiviert</span>'}
          <div class="small muted mono">${esc(n.hexId)} · ${esc(n.nodeTypeLabel)}</div></td>
        <td>${n.online ? '<span class="badge ok">Online</span>' : '<span class="badge bad">Offline</span>'}<div class="small muted">${fmtAgo(n.lastSeen)}</div></td>
        <td>${syncBadge(n)}</td>
        <td class="small">${nodeConfigSummary(n)}</td>
        <td class="num">${st.dist !== undefined && st.dist !== 255 ? st.dist : "–"}${st.cost !== undefined && st.cost < 255 ? `<div class="small muted" title="Routenkosten: erwartete Übertragungen bis zur Bridge-Station">${(st.cost / COST_PER_LINK).toFixed(1)}</div>` : ""}</td>
        <td class="num">${st.queueLen ? `<span class="badge warn">${st.queueLen}</span>` : st.queueLen === 0 ? "0" : "–"}</td>
        <td class="small">${fmtDuration(st.uptimeSec)}${st.flags !== undefined && !(st.flags & 2) ? '<div><span class="badge bad">RFID-Leser Fehler</span></div>' : ""}${st.flags !== undefined && !(st.flags & 1) ? '<div><span class="badge warn" title="Station hat keine Uhrzeit">Keine Zeit</span></div>' : ""}</td>
        <td><div class="row">
          <button class="btn small" data-node-edit="${n.nodeId}">Bearbeiten</button>
          <button class="btn small" data-node-identify="${n.nodeId}" title="LED-Ring blinkt bunt">Finden</button>
        </div></td>
      </tr>`;
    })
    .join("");

  $("#tab-nodes").innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:8px">
        <h2 style="margin:0">Funknetz</h2>
        <span class="spacer"></span>
        ${topoLegendHtml()}
        <button class="btn small" id="topo-reset" title="Stationen auf der Karte wieder automatisch nach Hops anordnen (verschobene Positionen werden verworfen; das Funknetz selbst bleibt unverändert)">Mesh zurücksetzen</button>
        <label class="check small topo-fallback" title="Funkverbindungen anzeigen, die gerade nicht als Route genutzt werden (Ausweichwege, falls eine Verbindung ausfällt)"><input type="checkbox" data-topo-fallback ${topo.showFallback ? "checked" : ""}> Show Ausweichrouten</label>
      </div>
      <div id="topo-hint"></div>
      <div id="topo" class="topo"></div>
      <p class="small muted" style="margin-bottom:0">Linien verbinden Geräte, die sich direkt hören; die Farbe zeigt die Verbindungsqualität (Anteil empfangener Beacons).
        Jede Station prüft alle 5 s ihre Nachbarn und wählt die Route mit den geringsten Kosten (erwartete Übertragungen) – dicke Linien sind die genutzten Routen.
        Farbe = Spielstatus, den die Station gemeldet (bestätigt) hat; die Bridge-Station ist immer blau mit Ring.
        Buchstabe im Kreis = Stationstyp (B = Bridge-Station, P = Punkte-Station, K = Kontostand-Station; Hops im Tooltip), gestrichelter Ring = Transaktionen im Puffer.
        Stationen lassen sich verschieben (Anordnung wird in diesem Browser gespeichert), ein Klick öffnet die Einstellungen.</p>
    </div>
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <span class="muted small">Stationen melden sich automatisch an. Änderungen werden sofort und bei Bedarf erneut an die Station gesendet.</span>
        <span class="spacer"></span>
        <button class="btn small danger" id="remove-stale" ${staleNodes().length ? "" : "disabled"}
          title="Entfernt alle Stationen, die sich seit mehr als 5 Minuten nicht gemeldet haben">
          Veraltete entfernen${staleNodes().length ? ` (${staleNodes().length})` : ""}</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Station</th><th>Status</th><th>Synchron</th><th>Einstellungen</th><th class="num" title="Funk-Sprünge bis zur Bridge-Station">Hops</th><th class="num" title="Noch nicht bestätigte Transaktionen">Puffer</th><th>Laufzeit</th><th></th></tr></thead>
        <tbody>${bridgeRow()}${rows || '<tr><td colspan="8" class="empty">Noch keine Station gefunden. Stationen erscheinen nach dem Einschalten (Heartbeat alle 20 s).</td></tr>'}</tbody>
      </table></div>
    </div>`;

  renderTopology($("#topo"), $("#topo-hint"));
  $("#remove-stale").onclick = openRemoveStaleModal;
  $("#topo-reset").onclick = resetTopoLayout;
  attachFallbackToggle($("#tab-nodes"));
  document.querySelectorAll("[data-node-edit]").forEach((b) => (b.onclick = () => openNodeModal(Number(b.dataset.nodeEdit))));
  document.querySelectorAll("[data-node-identify]").forEach((b) => (b.onclick = () => run(() => api("POST", `/nodes/${b.dataset.nodeIdentify}/identify`), "Signal gesendet")));
}

// Stations without a heartbeat for 5 minutes (same limit as the server).
const STALE_NODE_MS = 5 * 60_000;
function staleNodes() {
  const now = Date.now();
  return state.nodes.filter((n) => !n.lastSeen || now - n.lastSeen > STALE_NODE_MS);
}

function openRemoveStaleModal() {
  const stale = staleNodes();
  if (!stale.length) return;
  openModal(`
    <h2>${stale.length} veraltete Station${stale.length === 1 ? "" : "en"} entfernen?</h2>
    <p>Diese Stationen haben sich seit mehr als 5 Minuten nicht gemeldet:</p>
    <ul class="small">${stale.map((n) => `<li><strong>${esc(n.name)}</strong> <span class="mono muted">${esc(n.hexId)}</span> – zuletzt ${fmtAgo(n.lastSeen)}</li>`).join("")}</ul>
    <p class="small muted">Name und Einstellungen dieser Stationen werden gelöscht, ihre Transaktionen bleiben erhalten.
      Meldet sich ein Gerät später wieder, erscheint es neu mit Standard-Einstellungen.</p>
    <div class="modal-actions"><button class="btn" data-close>Abbrechen</button>
      <button class="btn danger solid" id="rs-go">Entfernen</button></div>`);
  $("#rs-go").onclick = () =>
    run(async () => {
      const r = await api("POST", "/nodes/remove-stale");
      closeModal();
      await loadNodes();
      renderNodes();
      renderStatus();
      toast(`${r.removed} Station${r.removed === 1 ? "" : "en"} entfernt`);
    });
}

function openNodeModal(nodeId) {
  const n = state.nodes.find((x) => x.nodeId === nodeId);
  if (!n) return;
  const type = state.nodeTypes.find((t) => t.id === n.nodeType);
  const typeFields = (type?.fields || [])
    .map((f) => {
      const v = n.typeConfig[f.key] ?? f.default;
      if (f.type === "bool") {
        return `<label class="check field"><input type="checkbox" data-type-field="${f.key}" ${v ? "checked" : ""}> ${esc(f.label)}</label>`;
      }
      return `<label class="field">${esc(f.label)}
        <input type="${f.type === "int" ? "number" : "text"}" data-type-field="${f.key}" value="${esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""}>
        ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</label>`;
    })
    .join("");

  openModal(`
    <h2>Station bearbeiten</h2>
    <p class="muted small mono" style="margin-top:-6px">${esc(n.hexId)}</p>
    <div class="type-head">
      <span class="type-letter">${esc(type?.letter ?? "?")}</span>
      <div>
        <div class="type-name">${esc(n.nodeTypeLabel)}</div>
        ${type ? `<div class="small muted">${esc(type.description)}</div>` : ""}
      </div>
    </div>
    <label class="field">Name<input type="text" id="nm-name" value="${esc(n.name)}" maxlength="40"></label>
    <label class="check field"><input type="checkbox" id="nm-enabled" ${n.enabled ? "checked" : ""}> Station aktiv</label>
    ${typeFields}
    ${
      type && type.usesCooldown === false
        ? `<p class="small muted">Jede Abfrage kostet <strong>${state.settings?.lookupCost ?? 0} Punkte</strong> –
          einstellbar unter Spieleinstellungen → Node-Einstellungen.</p>`
        : ""
    }
    <div class="modal-actions">
      ${n.online ? "" : '<button class="btn danger" id="nm-delete">Aus Liste entfernen</button>'}
      <button class="btn" id="nm-reboot">Neustart</button>
      <span class="spacer"></span>
      <button class="btn" data-close>Abbrechen</button>
      <button class="btn primary" id="nm-save">Speichern</button>
    </div>`);

  $("#nm-save").onclick = () =>
    run(async () => {
      const typeConfig = {};
      document.querySelectorAll("[data-type-field]").forEach((el) => {
        typeConfig[el.dataset.typeField] = el.type === "checkbox" ? el.checked : el.value;
      });
      const body = {name: $("#nm-name").value, enabled: $("#nm-enabled").checked, typeConfig};
      await api("PATCH", `/nodes/${nodeId}`, body);
      closeModal();
    }, "Station gespeichert – Einstellungen werden übertragen");
  $("#nm-reboot").onclick = () => run(() => api("POST", `/nodes/${nodeId}/reboot`), "Neustart-Befehl gesendet");
  const del = $("#nm-delete");
  if (del) {
    del.onclick = () => {
      if (del.dataset.armed) {
        run(async () => {
          await api("DELETE", `/nodes/${nodeId}`);
          closeModal();
        }, "Station entfernt");
      } else {
        del.dataset.armed = "1";
        del.textContent = "Wirklich entfernen?";
        del.classList.add("solid");
      }
    };
  }
}

// ---------------------------------------------------------------------------
// tab: settings
// ---------------------------------------------------------------------------

let teamDraft = null;

// Collapsible settings section; open/closed state is remembered per browser.
function readOpenSections() {
  try {
    return JSON.parse(localStorage.getItem("fk-sections") || "{}");
  } catch {
    return {};
  }
}

function section(key, title, summary, body) {
  const open = readOpenSections()[key] !== false; // open by default
  return `<details class="panel section" data-section="${key}" ${open ? "open" : ""}>
    <summary><span class="section-title">${title}</span><span class="section-summary">${summary}</span></summary>
    <div class="section-body">${body}</div>
  </details>`;
}

function attachSectionToggles(root) {
  root.querySelectorAll("details.section").forEach((d) => {
    d.addEventListener("toggle", () => {
      const openSections = readOpenSections();
      openSections[d.dataset.section] = d.open;
      try {
        localStorage.setItem("fk-sections", JSON.stringify(openSections));
      } catch {
        // preference only lasts for this page view
      }
    });
  });
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const teamsEditable = s.state === 0;
  if (!teamDraft || !teamsEditable) teamDraft = state.teams.map((t) => ({...t}));
  const lock = teamsEditable ? "" : "disabled";
  const g = state.gateway || {};

  $("#tab-settings").innerHTML = `
    <div class="settings-stack">
      ${section(
        "node",
        "Node-Einstellungen",
        `Abklingzeit ${s.defaultCooldownSec} s · Kontoabfrage ${s.lookupCost ?? 0} Pkt · Lautstärke ${s.volume} % · Helligkeit ${s.brightness} · Summer ${s.buzzer ? "an" : "aus"}`,
        `
          <p class="small muted">Gilt für alle Stationen und wird automatisch übertragen.
            Der Spielstatus wird oben in der Kopfzeile umgeschaltet; Punkte gibt es nur im Status <strong>Läuft</strong>.</p>
          <label class="field">Abklingzeit pro Karte und Station (Sekunden)
            <input type="number" id="set-cooldown" min="0" max="65000" value="${s.defaultCooldownSec}" style="max-width:160px">
            <span class="hint">Wie lange ein Spieler warten muss, bevor er an derselben Station wieder Punkte bekommt. Gilt für alle Stationen (außer Kontostand-Stationen).</span>
          </label>
          <label class="field">Kosten pro Kontoabfrage (Punkte)
            <input type="number" id="set-lookup-cost" min="0" max="30000" value="${s.lookupCost ?? 0}" style="max-width:160px">
            <span class="hint">So viele Punkte kostet es, an einer Kontostand-Station den eigenen Punktestand anzuzeigen. 0 = kostenlos.
              Reicht das Guthaben nicht, wird die Abfrage abgelehnt (ohne den Stand zu verraten).</span>
          </label>
          <label class="field"><span>Lautstärke (<span id="lbl-volume">${s.volume}</span> %)</span>
            <input type="range" id="node-volume" min="0" max="100" value="${s.volume}">
            <span class="hint">0 = stumm. Gilt für den Summer und später für das Soundmodul.</span>
          </label>
          <label class="field"><span>LED-Helligkeit (<span id="lbl-brightness">${s.brightness}</span>)</span>
            <input type="range" id="node-brightness" min="5" max="255" value="${s.brightness}">
            <span class="hint">Wird zusätzlich in der Firmware begrenzt, um das Netzteil zu schonen.</span>
          </label>
          <label class="check field"><input type="checkbox" id="node-buzzer" ${s.buzzer ? "checked" : ""}> Summer aktiv (Debug)</label>
          <div class="modal-actions"><button class="btn primary" id="node-save">Speichern</button></div>`,
      )}

      ${section(
        "teams",
        "Teams",
        `${state.teams.length} Teams${teamsEditable ? "" : " · gesperrt (nur in Vorbereitung bearbeitbar)"}`,
        `
          ${teamsEditable ? "" : '<div class="callout">Teams können nur im Status <strong>Vorbereitung</strong> bearbeitet werden.</div>'}
          <div id="team-list">
            ${teamDraft
              .map(
                (t, i) => `<div class="row" style="margin-bottom:8px">
                  <span class="muted" style="width:20px">${i + 1}</span>
                  <input type="color" data-team-color="${i}" value="${esc(t.color)}" ${lock}>
                  <input type="text" data-team-name="${i}" value="${esc(t.name)}" maxlength="40" style="flex:1" ${lock}>
                  <button class="btn small" data-team-remove="${i}" ${teamDraft.length <= 1 || !teamsEditable ? "disabled" : ""} title="Team entfernen">✕</button>
                </div>`,
              )
              .join("")}
          </div>
          <div class="row">
            <button class="btn" id="team-add" ${teamDraft.length >= 16 || !teamsEditable ? "disabled" : ""}>+ Team</button>
            <span class="spacer"></span>
            <button class="btn" id="team-reset" ${lock}>Verwerfen</button>
            <button class="btn primary" id="team-save" ${lock}>Speichern</button>
          </div>
          <p class="small muted">Maximal 16 Teams. Wird ein Team entfernt, werden dessen Spieler automatisch auf die kleinsten Teams verteilt.
            Die Farbe wird auf den Stationen beim erfolgreichen Scan angezeigt.</p>`,
      )}

      ${section(
        "bridge",
        "Bridge-Station",
        g.simulated ? "Simuliert" : g.connected ? `Verbunden über ${esc(g.path)}` : "Nicht verbunden",
        `
          <p class="small">
            ${
              g.simulated
                ? '<span class="badge warn">Simuliert</span> Keine echte Bridge-Station – Stationen und Karten werden vom Server simuliert.'
                : g.connected
                  ? `Verbunden über <strong>${esc(g.path)}</strong>`
                  : "<strong>Nicht verbunden</strong> – Bridge-Station per USB anschließen."
            }
            ${g.gateway?.id !== undefined ? `<br>ID <span class="mono">${(g.gateway.id >>> 0).toString(16).toUpperCase()}</span> · Firmware ${g.gateway.fw ?? "?"} · Puffer ${g.gateway.ql ?? 0}` : ""}
            <br><span class="muted">Karten-Epoche ${s.gameId} · Konfiguration v${s.version} · Korrekturliste v${state.adjVersion & 0xffff}</span>
          </p>
          <details><summary class="small">Debug-Ausgabe</summary><div class="log mono" id="gw-log"></div></details>`,
      )}

      ${section("firmware", "Node-Typen & Firmware", `${state.nodeTypes.length + 1} Firmwares · ESP32 per USB flashen`, '<div id="firmware-panel"><div class="empty">Lade…</div></div>')}
    </div>`;

  attachSectionToggles($("#tab-settings"));
  loadFirmwarePanel();

  $("#node-volume").oninput = (e) => ($("#lbl-volume").textContent = e.target.value);
  $("#node-brightness").oninput = (e) => ($("#lbl-brightness").textContent = e.target.value);
  $("#node-save").onclick = () =>
    run(
      () =>
        api("PATCH", "/settings", {
          defaultCooldownSec: Number($("#set-cooldown").value),
          lookupCost: Number($("#set-lookup-cost").value),
          volume: Number($("#node-volume").value),
          brightness: Number($("#node-brightness").value),
          buzzer: $("#node-buzzer").checked,
        }),
      "Node-Einstellungen gespeichert",
    );

  const syncDraft = () => {
    document.querySelectorAll("[data-team-name]").forEach((el) => (teamDraft[el.dataset.teamName].name = el.value));
    document.querySelectorAll("[data-team-color]").forEach((el) => (teamDraft[el.dataset.teamColor].color = el.value));
  };
  $("#team-add").onclick = () => {
    syncDraft();
    const palette = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#8e24aa", "#fb8c00", "#00acc1", "#d81b60", "#6d4c41", "#546e7a"];
    teamDraft.push({name: `Team ${teamDraft.length + 1}`, color: palette[teamDraft.length % palette.length]});
    renderSettings();
  };
  document.querySelectorAll("[data-team-remove]").forEach((b) => {
    b.onclick = () => {
      syncDraft();
      teamDraft.splice(Number(b.dataset.teamRemove), 1);
      renderSettings();
    };
  });
  $("#team-reset").onclick = () => {
    teamDraft = null;
    renderSettings();
  };
  $("#team-save").onclick = () =>
    run(async () => {
      syncDraft();
      await api(
        "PUT",
        "/teams",
        teamDraft.map(({name, color}) => ({name, color})),
      );
      teamDraft = null;
      await loadState();
      renderSettings();
    }, "Teams gespeichert");

  renderGatewayLog();
}

// ---------------------------------------------------------------------------
// node types & firmware flashing (Spieleinstellungen)
// ---------------------------------------------------------------------------

const flashUi = {info: null, ports: [], env: "", port: "", log: [], job: null};

async function loadFirmwarePanel(refresh = false) {
  try {
    const [info, ports, job] = await Promise.all([api("GET", `/firmware${refresh ? "?refresh=1" : ""}`), api("GET", "/firmware/ports"), api("GET", "/firmware/job")]);
    flashUi.info = info;
    flashUi.ports = ports;
    flashUi.job = job && job.id ? job : null;
    flashUi.log = (job?.log || []).map(normalizeFlashLine);
    if (!flashUi.env) flashUi.env = info.firmwares.find((f) => f.nodeType !== null)?.env || info.firmwares[0]?.env || "";
    if (!ports.some((p) => p.path === flashUi.port)) {
      flashUi.port = (ports.find((p) => p.likelyEsp && !p.isBridge) || ports.find((p) => p.likelyEsp) || ports[0])?.path || "";
    }
  } catch (err) {
    toast(err.message, true);
  }
  renderFirmwarePanel();
}

function renderFirmwarePanel() {
  const el = $("#firmware-panel");
  const info = flashUi.info;
  if (!el || !info) return;
  const running = flashUi.job?.state === "running";
  const g = state.gateway || {};

  const typeRows = [
    `<tr>
      <td><strong>Bridge-Station</strong></td>
      <td class="small">Verbindung zwischen Funknetz und PC, per USB am PC angeschlossen.</td>
      <td class="small muted">–</td>
      <td>${g.simulated ? '<span class="badge warn">Simuliert</span>' : g.connected ? '<span class="badge ok">Verbunden</span>' : '<span class="badge bad">Nicht verbunden</span>'}</td>
      <td class="mono">gateway</td>
    </tr>`,
    ...info.nodeTypes.map(
      (t) => `<tr>
        <td><strong>${esc(t.label)}</strong><div class="small muted">Typ ${t.id} · ${esc(t.key)}</div></td>
        <td class="small">${esc(t.description)}</td>
        <td class="small">${[...t.fields.map((f) => esc(f.label)), ...(t.usesCooldown ? ["Abklingzeit (Spieleinstellungen)"] : ["Kosten pro Abfrage (Spieleinstellungen)"])].join(", ")}</td>
        <td>${t.stations ? `<span class="badge ${t.online === t.stations ? "ok" : "warn"}">${t.online}/${t.stations} Online</span>` : '<span class="muted small">Keine</span>'}</td>
        <td class="mono">${esc(t.firmwareEnv)}</td>
      </tr>`,
    ),
  ].join("");

  const portOptions = flashUi.ports
    .map((p) => {
      const label = `${p.path}${p.description ? ` – ${p.description}` : ""}${p.isBridge ? " (Bridge-Station)" : ""}${p.likelyEsp ? "" : " (kein ESP erkannt)"}`;
      return `<option value="${esc(p.path)}" ${p.path === flashUi.port ? "selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
  const selectedPort = flashUi.ports.find((p) => p.path === flashUi.port);

  el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Typ</th><th>Beschreibung</th><th>Einstellungen</th><th>Stationen</th><th>Firmware</th></tr></thead>
      <tbody>${typeRows}</tbody>
    </table></div>

    <h3>ESP32 per USB flashen</h3>
    ${
      info.pio.found
        ? ""
        : `<div class="callout">PlatformIO wurde auf diesem PC nicht gefunden. Installation: VS-Code-Erweiterung „PlatformIO IDE“
      oder <span class="mono">pip install platformio</span>. Alternativ den Pfad in der Umgebungsvariable <span class="mono">FK_PIO</span> angeben.
      <button class="btn small" id="fw-recheck">Erneut prüfen</button></div>`
    }
    ${info.firmwareDirFound ? "" : `<div class="callout">Firmware-Projekt nicht gefunden: <span class="mono">${esc(info.firmwareDir)}</span></div>`}
    <div class="row" style="margin-bottom:8px">
      <label class="field" style="margin:0">Firmware
        <select id="fw-env" ${running ? "disabled" : ""}>
          ${info.firmwares.map((f) => `<option value="${esc(f.env)}" ${f.env === flashUi.env ? "selected" : ""}>${esc(f.label)}</option>`).join("")}
        </select>
      </label>
      <label class="field" style="margin:0;flex:1;min-width:220px">USB-Port
        <select id="fw-port" ${running ? "disabled" : ""}>${portOptions || '<option value="">Kein Gerät gefunden</option>'}</select>
      </label>
      <button class="btn" id="fw-ports" style="align-self:flex-end" ${running ? "disabled" : ""} title="Ports neu einlesen">↻</button>
      <button class="btn primary" id="fw-flash" style="align-self:flex-end"
        ${running || !info.pio.found || !flashUi.port ? "disabled" : ""}>Flashen</button>
    </div>
    <p class="small muted">Baut die Firmware und lädt sie auf das gewählte Gerät (der erste Durchlauf dauert länger).
      Einstellungen und gepufferte Transaktionen auf dem Gerät bleiben erhalten.
      ${selectedPort?.isBridge ? "<strong>Dieser Port gehört zur Bridge-Station – die Verbindung wird während des Flashens getrennt.</strong>" : ""}</p>
`;

  $("#fw-env").onchange = (e) => (flashUi.env = e.target.value);
  $("#fw-port").onchange = (e) => {
    flashUi.port = e.target.value;
    renderFirmwarePanel();
  };
  $("#fw-ports").onclick = () => loadFirmwarePanel();
  const recheck = $("#fw-recheck");
  if (recheck) recheck.onclick = () => loadFirmwarePanel(true);
  $("#fw-flash").onclick = () => {
    const fw = info.firmwares.find((f) => f.env === flashUi.env);
    openModal(`
      <h2>${esc(fw?.label ?? flashUi.env)} flashen?</h2>
      <p>Die Firmware <span class="mono">${esc(flashUi.env)}</span> wird auf das Gerät an <strong>${esc(flashUi.port)}</strong> geschrieben.
        Die bisherige Firmware auf diesem Gerät wird ersetzt.</p>
      ${selectedPort?.isBridge ? '<p class="callout">Das ist der Port der Bridge-Station: Die Verbindung zum Funknetz ist während des Flashens unterbrochen. Stationen puffern ihre Transaktionen so lange.</p>' : ""}
      <div class="modal-actions"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="fw-go">Flashen</button></div>`);
    $("#fw-go").onclick = () =>
      run(async () => {
        flashUi.log = [];
        flashUi.job = await api("POST", "/firmware/flash", {env: flashUi.env, port: flashUi.port});
        closeModal();
        renderFirmwarePanel();
        openFlashOverlay();
      });
  };
}

// --- flash output overlay ------------------------------------------------
// Floating window (bottom right, on every page) with the timestamped build and
// upload output. Opens automatically when flashing starts.

function normalizeFlashLine(entry) {
  return typeof entry === "string" ? {at: null, line: entry} : entry;
}

function flashLineHtml(e) {
  const cls = /error|fehlgeschlagen|✖/i.test(e.line) ? " err" : /✔|SUCCESS/.test(e.line) ? " ok" : "";
  return `<div class="fl-line${cls}"><span class="fl-time">${e.at ? fmtTime(e.at) : ""}</span><span>${esc(e.line)}</span></div>`;
}

function openFlashOverlay() {
  flashUi.overlayOpen = true;
  renderFlashOverlay();
}

function renderFlashOverlay() {
  const el = $("#flash-overlay");
  if (!flashUi.overlayOpen || !flashUi.job) {
    el.hidden = true;
    return;
  }
  const job = flashUi.job;
  const running = job.state === "running";
  const badge = running
    ? '<span class="badge info">Läuft…</span>'
    : job.state === "success"
      ? '<span class="badge ok">✔ Erfolgreich</span>'
      : job.state === "cancelled"
        ? '<span class="badge warn">Abgebrochen</span>'
        : '<span class="badge bad">✖ Fehlgeschlagen</span>';
  const duration = job.startedAt ? Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000) : null;
  el.innerHTML = `
    <div class="fo-head">
      <strong>Firmware flashen</strong>
      <span class="small muted">${esc(job.label)} → ${esc(job.port)} · gestartet ${fmtTime(job.startedAt)}${duration !== null && !running ? ` · ${duration} s` : ""}</span>
      <span class="spacer"></span>${badge}
    </div>
    <div class="fo-log mono" id="fo-log">${flashUi.log.map(flashLineHtml).join("") || '<div class="muted">Warte auf Ausgabe…</div>'}</div>
    <div class="fo-foot">
      ${running ? '<span class="small muted" id="fo-cancel-hint"></span><button class="btn danger solid" id="fo-cancel">Abbrechen</button>' : '<button class="btn" id="fo-close">Schließen</button>'}
    </div>`;
  el.hidden = false;

  const hide = () => {
    flashUi.overlayOpen = false;
    el.hidden = true;
  };
  const closeBtn = $("#fo-close");
  if (closeBtn) closeBtn.onclick = hide;
  const cancelBtn = $("#fo-cancel");
  if (cancelBtn) {
    // Two clicks: an interrupted upload leaves the device without working
    // firmware until it is flashed again.
    cancelBtn.onclick = () => {
      if (!cancelBtn.dataset.armed) {
        cancelBtn.dataset.armed = "1";
        cancelBtn.textContent = "Wirklich abbrechen?";
        $("#fo-cancel-hint").textContent = "Ein abgebrochener Upload muss danach wiederholt werden.";
        return;
      }
      cancelBtn.disabled = true;
      run(() => api("POST", "/firmware/cancel"));
    };
  }
  const log = $("#fo-log");
  log.scrollTop = log.scrollHeight;
}

function onFlashLog(entry) {
  const e = normalizeFlashLine(entry);
  flashUi.log.push(e);
  if (flashUi.log.length > 600) flashUi.log.splice(0, flashUi.log.length - 600);
  const log = $("#fo-log");
  if (!log || $("#flash-overlay").hidden) return;
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.querySelector(".muted")?.remove();
  log.insertAdjacentHTML("beforeend", flashLineHtml(e));
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onFlashStatus(job) {
  flashUi.job = job;
  if (job.state === "success") toast(`${job.label} erfolgreich geflasht`);
  else if (job.state === "failed") toast(`Flashen von ${job.label} fehlgeschlagen – siehe Ausgabe`, true);
  else if (job.state === "cancelled") toast(`Flashen von ${job.label} abgebrochen`, true);
  if (job.state === "running") flashUi.overlayOpen = true;
  renderFlashOverlay();
  if (state.tab === "settings") renderFirmwarePanel();
}

function renderGatewayLog() {
  const el = $("#gw-log");
  if (!el) return;
  const lines = state.gatewayLog || [];
  el.textContent = lines.length ? lines.map((l) => `${fmtTime(l.at)} ${l.line}`).join("\n") : "Keine Ausgaben.";
}

// ---------------------------------------------------------------------------
// tab: games (save / load / rename)
// ---------------------------------------------------------------------------

async function loadGames() {
  state.games = await api("GET", "/games");
}

function renderGames() {
  const games = state.games || [];
  const cur = games.find((g) => g.current);
  const others = games.filter((g) => !g.current);

  const rows = others
    .map(
      (g) => `<tr>
        <td><strong>${esc(g.name)}</strong><div class="small muted">erstellt ${fmtDateTime(g.created_at)}</div></td>
        <td>${g.summary ? stateBadge(g.summary.state) : '<span class="badge bad">Nicht lesbar</span>'}</td>
        <td class="num">${g.summary ? fmtNum(g.summary.players) : "–"}</td>
        <td class="num">${g.summary ? fmtNum(g.summary.points) : "–"}</td>
        <td class="small">${fmtDateTime(g.last_opened_at || g.created_at)}</td>
        <td><div class="row">
          <button class="btn small primary" data-game-load="${g.id}">Laden</button>
          <button class="btn small" data-game-view="${g.id}">Rangliste</button>
          <button class="btn small" data-game-rename="${g.id}">Umbenennen</button>
          <button class="btn small danger" data-game-delete="${g.id}">Löschen</button>
        </div></td>
      </tr>`,
    )
    .join("");

  $("#tab-games").innerHTML = `
    <div class="grid-2">
      <div class="panel">
        <h2>Aktuelles Spiel</h2>
        ${
          cur
            ? `
          <div class="row" style="margin-bottom:8px">
            <strong style="font-size:18px">${esc(cur.name)}</strong> ${cur.summary ? stateBadge(cur.summary.state) : ""}
          </div>
          <p class="small muted">${fmtNum(cur.summary?.players)} Spieler · ${fmtNum(cur.summary?.points)} Punkte · ${fmtNum(cur.summary?.transactions)} Transaktionen
            · erstellt ${fmtDateTime(cur.created_at)}</p>
          <p class="small muted">Das Spiel wird automatisch gespeichert – jede Transaktion und Änderung landet sofort in der Datenbank.
            Zum Unterbrechen das Spiel oben auf <strong>Pausiert</strong> stellen.</p>
          <div class="row">
            <button class="btn" data-game-rename="${cur.id}">Umbenennen</button>
            <button class="btn" id="game-copy">Kopie speichern…</button>
          </div>`
            : '<div class="empty">Kein Spiel geladen.</div>'
        }
      </div>

      <div class="panel">
        <h2>Neues Spiel</h2>
        <label class="field">Name<input type="text" id="new-game-name" maxlength="60" placeholder="z. B. Sommerfest 2026"></label>
        <p class="small muted">Das aktuelle Spiel wird pausiert und bleibt gespeichert. Teams, Stationen und Einstellungen werden übernommen,
          Spieler melden sich beim ersten Scan neu an. Karten werden beim ersten Scan automatisch zurückgesetzt.</p>
        <div class="modal-actions"><button class="btn primary" id="new-game-go">Neues Spiel anlegen</button></div>
      </div>
    </div>

    <div class="panel">
      <h2>Gespeicherte Spiele</h2>
      ${
        rows
          ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Status</th><th class="num">Spieler</th><th class="num">Punkte</th><th>Zuletzt geladen</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
          : '<div class="empty">Keine weiteren Spiele gespeichert.</div>'
      }
    </div>`;

  $("#new-game-go").onclick = () =>
    run(async () => {
      $("#new-game-go").disabled = true;
      await api("POST", "/games", {name: $("#new-game-name").value});
    }, "Neues Spiel angelegt und geladen");
  const copyBtn = $("#game-copy");
  if (copyBtn) copyBtn.onclick = () => openSaveCopyModal(cur);
  document.querySelectorAll("[data-game-load]").forEach((b) => (b.onclick = () => openLoadModal(gameById(b.dataset.gameLoad))));
  document.querySelectorAll("[data-game-view]").forEach((b) => (b.onclick = () => openGameLeaderboard(Number(b.dataset.gameView))));
  document.querySelectorAll("[data-game-rename]").forEach((b) => (b.onclick = () => openRenameModal(gameById(b.dataset.gameRename))));
  document.querySelectorAll("[data-game-delete]").forEach((b) => (b.onclick = () => openDeleteModal(gameById(b.dataset.gameDelete))));
}

function gameById(id) {
  return state.games.find((g) => g.id === Number(id));
}

function openRenameModal(g) {
  if (!g) return;
  openModal(`
    <h2>Spiel umbenennen</h2>
    <label class="field">Name<input type="text" id="gr-name" maxlength="60" value="${esc(g.name)}"></label>
    <div class="modal-actions"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="gr-save">Speichern</button></div>`);
  const input = $("#gr-name");
  input.focus();
  input.select();
  const save = () =>
    run(async () => {
      await api("PATCH", `/games/${g.id}`, {name: input.value});
      closeModal();
    }, "Spiel umbenannt");
  $("#gr-save").onclick = save;
  // Note: an on* handler returning false cancels the key press - no expression body here.
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
  };
}

function openSaveCopyModal(g) {
  openModal(`
    <h2>Kopie speichern</h2>
    <p class="small muted">Speichert den aktuellen Stand als eigenes Spiel (z. B. als Sicherung vor einer Änderung).
      Das aktuelle Spiel bleibt geladen und läuft unverändert weiter.</p>
    <label class="field">Name der Kopie<input type="text" id="gc-name" maxlength="60" value="${esc(`${g.name} (Kopie)`)}"></label>
    <div class="modal-actions"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="gc-save">Speichern</button></div>`);
  $("#gc-name").focus();
  $("#gc-save").onclick = () =>
    run(async () => {
      await api("POST", "/games/save-copy", {name: $("#gc-name").value});
      closeModal();
    }, "Kopie gespeichert");
}

function openLoadModal(g) {
  if (!g) return;
  const running = state.settings?.state === 1;
  openModal(`
    <h2>„${esc(g.name)}“ laden?</h2>
    <p>${running ? "Das aktuelle Spiel läuft gerade und wird <strong>pausiert</strong>. " : ""}Das aktuelle Spiel bleibt gespeichert und kann später wieder geladen werden.</p>
    <p class="small muted">Die gespeicherten Punktestände und Teams werden beim ersten Scan jeder Karte automatisch auf die Karte zurückgeschrieben.
      Das geladene Spiel startet pausiert – zum Weiterspielen oben auf <strong>Läuft</strong> stellen.</p>
    <div class="modal-actions"><button class="btn" data-close>Abbrechen</button><button class="btn primary" id="gl-go">Laden</button></div>`);
  $("#gl-go").onclick = () =>
    run(async () => {
      $("#gl-go").disabled = true;
      await api("POST", `/games/${g.id}/load`);
      closeModal();
    }, `„${g.name}“ geladen`);
}

function openDeleteModal(g) {
  if (!g) return;
  openModal(`
    <h2>„${esc(g.name)}“ löschen?</h2>
    <p>Das Spiel mit allen Spielern, Punkteständen und Transaktionen wird <strong>endgültig</strong> gelöscht.</p>
    <label class="field">Zur Bestätigung den Namen des Spiels eingeben<input type="text" id="gd-confirm" autocomplete="off"></label>
    <div class="modal-actions"><button class="btn" data-close>Abbrechen</button><button class="btn danger solid" id="gd-go" disabled>Endgültig löschen</button></div>`);
  const input = $("#gd-confirm");
  const go = $("#gd-go");
  input.focus();
  input.oninput = () => (go.disabled = input.value.trim() !== g.name);
  go.onclick = () =>
    run(async () => {
      await api("DELETE", `/games/${g.id}`);
      closeModal();
    }, "Spiel gelöscht");
}

async function openGameLeaderboard(id) {
  let data;
  try {
    data = await api("GET", `/games/${id}/leaderboard`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const chip = (teamId) => {
    const t = data.teams.find((x) => x.id === teamId);
    return t ? `<span class="team-chip"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>` : "";
  };
  const teamRows = data.teams;
  openModal(`
    <h2>Rangliste: ${esc(data.game.name)}</h2>
    <p class="small muted">${stateBadge(data.game.summary.state)} · ${fmtNum(data.game.summary.players)} Spieler · nur Ansicht, das Spiel wird nicht geladen</p>
    <h3>Teams</h3>
    <ol class="lb-list">${
      teamRows
        .map(
          (t, i) => `<li class="lb-item"><div class="lb-rank">${i + 1}</div>
        <div class="lb-name team-chip"><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}
          <span class="small muted">(${t.members})</span></div>
        <div class="lb-points">${fmtNum(t.points)}</div></li>`,
        )
        .join("") || '<div class="empty">Keine Teams</div>'
    }</ol>
    <h3>Spieler</h3>
    <ol class="lb-list" style="max-height:40vh;overflow:auto">${
      data.players
        .map(
          (p, i) => `<li class="lb-item"><div class="lb-rank">${i + 1}</div>
        <div><div class="lb-name">${esc(p.name)}</div><div class="small muted">${chip(p.teamId)}</div></div>
        <div class="lb-points">${fmtNum(p.points)}</div></li>`,
        )
        .join("") || '<div class="empty">Keine Spieler</div>'
    }</ol>
    <div class="modal-actions"><button class="btn" data-close>Schließen</button></div>`);
}

// ---------------------------------------------------------------------------
// modal & tabs
// ---------------------------------------------------------------------------

function openModal(html) {
  $("#modal-content").innerHTML = html;
  $("#modal").hidden = false;
  document.querySelectorAll("#modal [data-close]").forEach((b) => (b.onclick = closeModal));
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-content").innerHTML = "";
}

$("#modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});

// Every element with data-player (names in all lists, leaderboard rows) opens
// the player dialog - one handler for the whole dashboard.
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-player]");
  if (!el || el.closest("#modal")) return;
  e.preventDefault();
  openPlayerModal(el.dataset.player);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#modal").hidden) closeModal();
});

const renderers = {
  monitor: renderMonitor,
  leaderboard: renderLeaderboard,
  players: renderPlayers,
  transactions: renderTransactions,
  nodes: renderNodes,
  games: renderGames,
  settings: renderSettings,
};

// URL of every page (client-side routing via the History API). The server
// serves index.html for these paths (see PAGES in src/index.js).
const ROUTES = {
  monitor: "/",
  leaderboard: "/score",
  players: "/players",
  transactions: "/transactions",
  nodes: "/stations",
  games: "/games",
  settings: "/settings",
};
const PAGE_TITLES = {
  monitor: "Monitoring",
  leaderboard: "Rangliste",
  players: "Spieler",
  transactions: "Transaktionen",
  nodes: "Stationen",
  games: "Spiele",
  settings: "Spieleinstellungen",
};

function tabFromPath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/monitoring") return "monitor";
  return Object.keys(ROUTES).find((t) => ROUTES[t] === p) || "monitor";
}

async function switchTab(tab, {push = true} = {}) {
  if (!renderers[tab]) tab = "monitor";
  if (push && location.pathname !== ROUTES[tab]) history.pushState({tab}, "", ROUTES[tab]);
  document.title = `${PAGE_TITLES[tab]} – Flötende Kröten`;
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));
  document.body.classList.toggle("wide", tab === "monitor");
  try {
    if (tab === "monitor") await loadStats();
    if (tab === "transactions") await loadTransactions();
    if (tab === "nodes") await loadNodes();
    if (tab === "games") await loadGames();
    if (tab === "settings") await loadGateway();
  } catch (err) {
    toast(err.message, true);
  }
  renderers[tab]();
}

document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
$("#brand").onclick = (e) => {
  e.preventDefault();
  switchTab("monitor");
};
// Browser back / forward.
window.addEventListener("popstate", () => {
  closeModal();
  switchTab(tabFromPath(location.pathname), {push: false});
});

// ---------------------------------------------------------------------------
// live updates
// ---------------------------------------------------------------------------

const refreshPlayers = debounce(async () => {
  await loadPlayers();
  renderStatus(); // player count in the header
  if (state.tab === "leaderboard") renderLeaderboard();
  if (state.tab === "monitor") {
    renderMonitorScores();
    renderMonitorKpis();
  }
  if (state.tab === "players" && $("#modal").hidden) renderPlayers();
}, 300);

const refreshNodes = debounce(async () => {
  await loadNodes();
  renderStatus();
  if (state.tab === "nodes" && $("#modal").hidden) renderNodes();
  if (state.tab === "monitor") {
    renderMonitorMap();
    renderMonitorKpis();
  }
}, 300);

const refreshSettings = debounce(async () => {
  await loadState();
  if (state.tab === "settings" && $("#modal").hidden && !document.activeElement?.matches("input")) renderSettings();
  if (state.tab === "leaderboard") renderLeaderboard();
  if (state.tab === "monitor") renderMonitorKpis();
}, 300);

// A different game may have been loaded (also from another browser window):
// reload everything that belongs to the game.
const refreshGames = debounce(async () => {
  const previousId = state.game?.id;
  await loadState(); // handles a game switch (onGameSwitched)
  if (state.game?.id !== previousId) return;
  if (state.tab === "games" && $("#modal").hidden) {
    await loadGames();
    renderGames();
  } else {
    renderStatus();
  }
}, 300);

const refreshGateway = debounce(async () => {
  if (state.tab === "settings") await loadGateway();
  else await loadState();
  if (state.tab === "nodes" && $("#modal").hidden) renderNodes(); // bridge node row
  if (state.tab === "monitor") renderMonitorKpis(); // map follows with the next nodes update
}, 500);

function connectWs() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const {type, data} = JSON.parse(ev.data);
    if (type === "tx") {
      state.newTxIds.add(data.id);
      setTimeout(() => state.newTxIds.delete(data.id), 2500);
      // Manual changes are audit-log only: not in the live feed.
      if (!isManual(data)) {
        state.feed.unshift(data);
        if (state.feed.length > 100) state.feed.length = 100;
      }
      if (state.tab === "monitor" && !isManual(data)) {
        renderMonitorFeed();
        pulseTransaction(data);
        refreshStats();
      }
      if (txMatchesFilter(data)) {
        state.txs.unshift(data);
        if (state.tab === "transactions") renderTransactions();
      }
    } else if (type === "players") refreshPlayers();
    else if (type === "nodes") refreshNodes();
    else if (type === "settings") refreshSettings();
    else if (type === "gateway") refreshGateway();
    else if (type === "games") refreshGames();
    else if (type === "flash-log") onFlashLog(data);
    else if (type === "radio") pulseFrame(data);
    else if (type === "flash") onFlashStatus(data);
  };
  ws.onclose = () => {
    $("#status").innerHTML = '<span class="badge bad">Verbindung zum Server verloren – verbinde neu…</span>';
    setTimeout(() => {
      connectWs();
      init();
    }, 2000);
  };
}

async function init() {
  try {
    await loadState();
    await Promise.all([loadPlayers(), loadNodes(), loadFeed()]);
    renderStatus();
    await switchTab(state.tab, {push: false});
    // A flash started from another window is still running: show its output.
    const job = await api("GET", "/firmware/job").catch(() => null);
    if (job?.state === "running") {
      flashUi.job = job;
      flashUi.log = (job.log || []).map(normalizeFlashLine);
      openFlashOverlay();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

state.tab = tabFromPath(location.pathname); // open the page from the URL
init();
connectWs();
setInterval(() => {
  // keep "vor x s" labels fresh
  if (state.tab === "nodes" && $("#modal").hidden) renderNodes();
}, 10000);
