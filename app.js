/* IS-gruppen – passbokning */
(() => {
  "use strict";
  const APP_VERSION = "2.3 (redigerbara guider)";

  // ---------- Konstanter ----------
  const WORK_TYPES = {
    "Uppspolning":            [1, 3],
    "Spolning tankvagn":      [1, 2],
    "Slangspolning":          [1, 2],
    "Tankvagn + slang lilla": [1, 2],
    "Snöröjning":             [1, 2],
    "Spårning":               [1, 1],
    "Hyvling":                [1, 1],
    "Övrigt":                 [1, 2],
  };
  const PLACES = ["Båda", "Stora planen", "Lilla planen"];
  const DAY = 86400000;
  const WEEKDAYS = ["Söndag", "Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag"];
  const WD_SHORT = ["Sön", "Mån", "Tis", "Ons", "Tor", "Fre", "Lör"];
  const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

  // ---------- Lagring ----------
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const sess = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} },
  };

  // ---------- State ----------
  const S = {
    people: [], shifts: [],
    meId: Number(store.get("isg_me")) || null,
    pin: sess.get("isg_pin"),
    filter: store.get("isg_filter", "all"),
    view: store.get("isg_view", null), // "list" | "week" | null (auto)
    listDays: 14,
    weekStart: startOfWeek(new Date()),
  };

  const cfg = window.ISG_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("DITT-PROJEKT") || !window.supabase) {
    $("#main").innerHTML = `<div class="setup"><h2>Nästan klart!</h2>
      <p>Appen är inte kopplad till databasen ännu. Öppna <b>config.js</b> och klistra in
      <b>Project URL</b> och <b>Publishable key</b> från Supabase (se GUIDE.md).</p></div>`;
    $("#newBtn").style.display = "none";
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

  // ---------- Datum ----------
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function startOfWeek(d) { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const hm = (d) => d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayLabel = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const shortDay = (d) => `${WD_SHORT[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY + 1) / 7);
  }
  const timeRange = (s) => `${hm(s.start)}–${hm(s.end)}`;

  // ---------- Hjälp ----------
  const me = () => S.people.find((p) => p.id === S.meId && p.active) || null;
  const actor = () => me()?.name || "Okänd";
  const personName = (id) => S.people.find((p) => p.id === id)?.name || "?";
  const isAdmin = () => !!S.pin;
  const isWeekView = () => (S.view || (window.matchMedia("(min-width: 900px)").matches ? "week" : "list")) === "week";

  function status(s) {
    const n = s.bookings.length;
    if (s.end <= new Date()) return "past";
    if (n < s.min_people) return s.is_jour ? "jour" : "red";
    if (n >= s.max_people) return "full";
    return "green";
  }
  const countText = (s) => `${s.bookings.length} av ${s.min_people === s.max_people ? s.max_people : s.min_people + "–" + s.max_people}`;
  const isMine = (s) => S.meId && s.bookings.some((b) => b.person_id === S.meId);

  let toastTimer;
  function toast(msg, err = false) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), err ? 5000 : 2500);
  }

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) { toast(error.message || "Något gick fel", true); throw error; }
    return data;
  }

  // ---------- Data ----------
  let loading = false, again = false;
  async function load() {
    if (loading) { again = true; return; }
    loading = true;
    try {
      const today = startOfDay(new Date());
      const from = new Date(Math.min(today, S.weekStart));
      const to = new Date(Math.max(addDays(today, S.listDays), addDays(S.weekStart, 7)));
      const [p, s] = await Promise.all([
        sb.from("people").select("*").order("name"),
        sb.from("shifts")
          .select("*, bookings(person_id, booked_by, created_at), notes(id, person_id, body, created_at)")
          .gte("end_at", from.toISOString()).lt("start_at", to.toISOString())
          .order("start_at"),
      ]);
      if (p.error || s.error) throw p.error || s.error;
      S.people = p.data;
      await loadWorkTypes();
      S.shifts = s.data.map((x) => ({
        ...x, start: new Date(x.start_at), end: new Date(x.end_at),
        bookings: (x.bookings || []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
        notes: (x.notes || []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
      }));
      render();
      refreshOpenModal();
    } catch (e) {
      console.error(e);
      toast("Kunde inte hämta schemat. Kontrollera nätet.", true);
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }

  let debounce;
  sb.channel("isg")
    .on("postgres_changes", { event: "*", schema: "public" }, () => { clearTimeout(debounce); debounce = setTimeout(load, 300); })
    .subscribe();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden) render(); }, 60000); // uppdatera "passerat"-status


  // ---------- Väder (SMHI öppna data, snow1g, CC BY 4.0) ----------
  const WX_URL = "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/15.42/lat/60.486/data.json";
  const WX = { series: [], fetched: 0 };
  const SNOW_SYMBOLS = new Set([15, 16, 17, 25, 26, 27]);
  const SLEET_SYMBOLS = new Set([12, 13, 14, 22, 23, 24]);
  // Väderikoner som SVG (färg via CSS-klass, fungerar i ljust och mörkt tema)
  const SVG = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cloud: '<path d="M17.5 19H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 20 11.5 3.8 3.8 0 0 1 17.5 19z"/>',
    rain: '<path d="M16 13H8a4 4 0 1 1 1-7.9A5 5 0 0 1 18 8a3 3 0 0 1-2 5z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    snow: '<path d="M12 2v20M4.2 7l15.6 10M4.2 17L19.8 7M9 4l3 2 3-2M9 20l3-2 3 2"/>',
    note: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    template: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    filldown: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  };
  function svg(name, size = 16, cls = "") {
    return `<svg class="${cls}" aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SVG[name]}</svg>`;
  }
  function wxIcon(code, size = 15) {
    let k = "cloud";
    if (code <= 2) k = "sun";
    else if (code <= 7) k = "cloud";
    else if (code <= 11 || (code >= 18 && code <= 21)) k = "rain";
    else k = "snow";
    return svg(k, size, "ic-" + k);
  }
  // WMO-väderkod (Open-Meteo) → ungefärlig SMHI-symbolkod
  function wmoToSym(c) {
    if (c === 0) return 1; if (c === 1) return 2; if (c === 2) return 3; if (c === 3) return 6;
    if (c === 45 || c === 48) return 7;
    if (c >= 51 && c <= 55) return 18; if (c === 56 || c === 57 || c === 66 || c === 67) return 22;
    if (c === 61) return 18; if (c === 63) return 19; if (c === 65) return 20;
    if (c === 71 || c === 77) return 25; if (c === 73) return 26; if (c === 75) return 27;
    if (c === 80) return 8; if (c === 81) return 9; if (c === 82) return 10;
    if (c === 85) return 15; if (c === 86) return 17; if (c >= 95) return 11;
    return 4;
  }
  async function fetchSmhi() {
    const r = await fetch(WX_URL);
    if (!r.ok) throw new Error("SMHI " + r.status);
    const j = await r.json();
    return (j.timeSeries || []).map((x) => ({
      t: new Date(x.time).getTime(), temp: x.data.air_temperature, sym: x.data.symbol_code,
      pr: x.data.precipitation_amount_mean || 0, wind: x.data.wind_speed,
    }));
  }
  async function fetchOpenMeteo() {
    const u = "https://api.open-meteo.com/v1/forecast?latitude=60.486&longitude=15.42" +
      "&hourly=temperature_2m,weather_code,precipitation,wind_speed_10m&wind_speed_unit=ms&timezone=UTC&forecast_days=10";
    const r = await fetch(u);
    if (!r.ok) throw new Error("Open-Meteo " + r.status);
    const h = (await r.json()).hourly;
    // Open-Meteo anger nederbörd för timmen FÖRE tidpunkten, precis som SMHI → samma tolkning
    return h.time.map((t, i) => ({
      t: new Date(t + "Z").getTime(), temp: h.temperature_2m[i], sym: wmoToSym(h.weather_code[i]),
      pr: h.precipitation[i] || 0, wind: h.wind_speed_10m[i],
    }));
  }
  async function loadWeather() {
    if (Date.now() - WX.fetched < 30 * 60000) return;
    let series = null, source = "";
    try { series = await fetchSmhi(); source = "SMHI (CC BY 4.0)"; }
    catch (e) {
      console.warn("SMHI gick inte att hämta, provar Open-Meteo", e);
      try { series = await fetchOpenMeteo(); source = "Open-Meteo.com (CC BY 4.0)"; }
      catch (e2) { console.warn("Väder kunde inte hämtas", e2); return; }
    }
    WX.series = series.filter((x) => x.temp !== undefined && x.temp !== null && x.temp > -90);
    WX.fetched = Date.now();
    const src = document.getElementById("wxsrc"); if (src) src.textContent = "Väderprognos: " + source;
    render(); refreshOpenModal();
  }
  // Prognospunkter som täcker intervallet [from, to). Glesa steg längre fram: ta närmaste punkt.
  function wxPoints(from, to) {
    if (!WX.series.length) return [];
    const a = from.getTime(), b = to.getTime();
    let pts = WX.series.filter((x) => x.t > a && x.t <= b + 3600000 * 0.5);
    if (!pts.length) {
      const near = WX.series.reduce((best, x) => Math.abs(x.t - a) < Math.abs(best.t - a) ? x : best, WX.series[0]);
      if (Math.abs(near.t - a) <= 3 * 3600000) pts = [near];
    }
    return pts;
  }
  function wxSummary(pts) {
    if (!pts.length) return null;
    const temps = pts.map((p) => p.temp);
    const snow = pts.some((p) => SNOW_SYMBOLS.has(p.sym) || (SLEET_SYMBOLS.has(p.sym)));
    const worst = pts.reduce((w, p) => (p.sym > w.sym ? p : w), pts[0]);
    return { min: Math.round(Math.min(...temps)), max: Math.round(Math.max(...temps)), icon: wxIcon(worst.sym),
             snow, pr: pts.reduce((sum, p) => sum + p.pr, 0), wind: Math.round(Math.max(...pts.map((p) => p.wind))) };
  }
  const tempTxt = (w) => w.min === w.max ? `${w.min}°` : `${w.min}…${w.max}°`;
  function wxShift(s) {
    if (s.end <= new Date()) return "";
    const w = wxSummary(wxPoints(s.start, s.end));
    if (!w) return "";
    return `<span class="wx${w.snow ? " snow" : ""}" title="Väderprognos">${w.icon}${tempTxt(w)}${w.snow ? " snö" : ""}</span>`;
  }
  function wxDay(d) {
    const from = startOfDay(d), to = addDays(from, 1);
    if (to <= new Date()) return "";
    const w = wxSummary(wxPoints(from, to));
    if (!w) return "";
    return `<span class="wxday">${w.icon}${w.min}…${w.max}°${w.pr >= 0.5 ? ` · ${w.pr.toFixed(1).replace(".", ",")} mm` : ""}</span>`;
  }
  function wxDetail(s) {
    const pts = wxPoints(s.start, s.end);
    if (s.end <= new Date() || !pts.length) return "";
    return `<section><h4>Väder under passet</h4><div class="wxrow">${pts.map((p) =>
      `<span><b>${hm(new Date(p.t))}</b><br>${wxIcon(p.sym, 18)} ${Math.round(p.temp)}°<br><small>${Math.round(p.wind)} m/s${p.pr >= 0.1 ? ` · ${p.pr.toFixed(1).replace(".", ",")} mm` : ""}</small></span>`).join("")}</div></section>`;
  }

  // ---------- Typ av arbete (från databasen, annars inbyggd lista) ----------
  S.workTypes = Object.entries(WORK_TYPES).map(([name, [mn, mx]], i) => ({ id: null, name, min_people: mn, max_people: mx, sort_order: i }));
  S.workTypesFromDb = false;
  async function loadWorkTypes() {
    const { data, error } = await sb.from("work_types").select("*").eq("active", true).order("sort_order").order("id");
    if (!error && data && data.length) { S.workTypes = data; S.workTypesFromDb = true; }
  }
  const wtDefaults = (name) => { const w = S.workTypes.find((x) => x.name === name); return w ? [w.min_people, w.max_people] : [1, 2]; };

  function openWorkTypes() {
    if (!S.workTypesFromDb) {
      modal(`<h2>Typ av arbete</h2><div class="alert">Redigering är inte installerad i databasen än.
        Kör filen <b>supabase-v3-arbetstyper.sql</b> i Supabase → SQL Editor → New query (se GUIDE.md).</div>`);
      return;
    }
    const list = S.workTypes;
    const m = modal(`<h2>Typ av arbete</h2>
      <div class="meta">Valen som finns när man lägger upp ett pass. Minst/max är förval för antal personer.</div>
      <section>
        <div class="wt-head"><span>Namn</span><span>Minst</span><span>Max</span><span></span></div>
        ${list.map((w, i) => `<div class="wt-row" data-id="${w.id}">
          <input type="text" maxlength="40" value="${esc(w.name)}" aria-label="Namn">
          <input type="number" min="1" max="10" value="${w.min_people}" aria-label="Minst antal">
          <input type="number" min="1" max="10" value="${w.max_people}" aria-label="Max antal">
          <div class="wt-btns">
            <button class="icon-btn" data-up ${i === 0 ? "disabled" : ""} aria-label="Flytta upp">↑</button>
            <button class="icon-btn" data-down ${i === list.length - 1 ? "disabled" : ""} aria-label="Flytta ner">↓</button>
            <button class="btn" data-save>Spara</button>
            <button class="icon-btn danger" data-del aria-label="Ta bort">${svg("trash", 15)}</button>
          </div></div>`).join("")}
      </section>
      <section><h4>Lägg till ny typ</h4>
        <div class="wt-row">
          <input type="text" id="wtNew" maxlength="40" placeholder="T.ex. Isvård" aria-label="Namn på ny typ">
          <input type="number" id="wtNewMin" min="1" max="10" value="1" aria-label="Minst antal">
          <input type="number" id="wtNewMax" min="1" max="10" value="2" aria-label="Max antal">
          <div class="wt-btns"><button class="btn primary" id="wtAdd">Lägg till</button></div>
        </div>
        <p class="gnote">Byter du namn eller tar bort en typ behåller befintliga pass och mallar sin gamla text.</p>
      </section>`);
    const again = async () => { await loadWorkTypes(); openWorkTypes(); };
    m.querySelectorAll(".wt-row[data-id]").forEach((row) => {
      const id = Number(row.dataset.id);
      const [nameI, minI, maxI] = row.querySelectorAll("input");
      row.querySelector("[data-save]").onclick = async () => {
        const mn = Number(minI.value), mx = Number(maxI.value);
        if (!(mn >= 1 && mx >= mn && mx <= 10)) return toast("Kontrollera minst/max (1–10, max ≥ minst)", true);
        try { await rpc("save_work_type", { p_id: id, p_name: nameI.value, p_min: mn, p_max: mx, p_pin: S.pin, p_actor: actor() }); toast("Sparat ✓"); again(); } catch {}
      };
      row.querySelector("[data-del]").onclick = async () => {
        if (!confirm(`Ta bort "${nameI.value}" ur listan? Befintliga pass påverkas inte.`)) return;
        try { await rpc("delete_work_type", { p_id: id, p_pin: S.pin, p_actor: actor() }); toast("Borttagen"); again(); } catch {}
      };
      row.querySelector("[data-up]").onclick = async () => { try { await rpc("move_work_type", { p_id: id, p_dir: -1, p_pin: S.pin }); again(); } catch {} };
      row.querySelector("[data-down]").onclick = async () => { try { await rpc("move_work_type", { p_id: id, p_dir: 1, p_pin: S.pin }); again(); } catch {} };
    });
    $("#wtAdd", m).onclick = async () => {
      const name = $("#wtNew", m).value.trim(), mn = Number($("#wtNewMin", m).value), mx = Number($("#wtNewMax", m).value);
      if (!name) return toast("Skriv ett namn", true);
      if (!(mn >= 1 && mx >= mn && mx <= 10)) return toast("Kontrollera minst/max (1–10, max ≥ minst)", true);
      try { await rpc("save_work_type", { p_id: null, p_name: name, p_min: mn, p_max: mx, p_pin: S.pin, p_actor: actor() }); toast(name + " tillagd ✓"); again(); } catch {}
    };
  }

  // ---------- Rendering ----------
  function render() {
    renderHeader();
    renderToolbar();
    isWeekView() ? renderWeek() : renderList();
  }

  function renderHeader() {
    const m = me();
    $("#meBtn").textContent = m ? m.name : "Vem är du?";
    const dark = document.documentElement.dataset.theme === "dark";
    const tb = $("#themeBtn");
    tb.innerHTML = svg(dark ? "sun" : "moon", 18);
    tb.setAttribute("aria-label", dark ? "Byt till ljust tema" : "Byt till mörkt tema");
    tb.title = tb.getAttribute("aria-label");
    const a = $("#adminBtn");
    a.innerHTML = `${svg("lock", 16)}<span class="hlabel">${isAdmin() ? "Admin ✓" : "Admin"}</span>`;
    a.setAttribute("aria-label", isAdmin() ? "Adminläge på" : "Admin");
    a.classList.toggle("admin-on", isAdmin());
  }

  function renderToolbar() {
    const tb = $("#toolbar");
    const week = isWeekView();
    const f = (k, t) => `<button data-f="${k}" class="${S.filter === k ? "on" : ""}">${t}</button>`;
    tb.innerHTML = `
      ${week ? `<div class="weeknav"><button class="btn" data-wk="-1">‹</button><b>Vecka ${isoWeek(S.weekStart)} · ${S.weekStart.getDate()} ${MONTHS[S.weekStart.getMonth()]}</b><button class="btn" data-wk="1">›</button><button class="btn" data-wk="0">Idag</button></div>`
             : `<div class="seg">${f("all", "Alla")}${f("mine", "Mina pass")}${f("missing", "Saknar folk")}</div>`}
      <span class="spacer"></span>
      <button class="btn" id="shareBtn">📣 Dela lediga pass</button>
      <button class="btn" id="logBtn">Logg</button>
      ${isAdmin() ? `<button class="btn" id="tplBtn">${svg("template", 14)} Mallar</button>` : ""}
      <div class="seg viewseg"><button data-v="list" class="${!week ? "on" : ""}">Lista</button><button data-v="week" class="${week ? "on" : ""}">Vecka</button></div>`;
    tb.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { S.filter = b.dataset.f; store.set("isg_filter", S.filter); render(); });
    tb.querySelectorAll("[data-v]").forEach((b) => b.onclick = () => { S.view = b.dataset.v; store.set("isg_view", S.view); render(); });
    tb.querySelectorAll("[data-wk]").forEach((b) => b.onclick = () => {
      const n = Number(b.dataset.wk);
      S.weekStart = n === 0 ? startOfWeek(new Date()) : addDays(S.weekStart, 7 * n);
      render(); load();
    });
    $("#shareBtn").onclick = shareOpenShifts;
    $("#logBtn").onclick = openLog;
    $("#tplBtn")?.addEventListener("click", () => openTemplates());
  }

  const initials = (name) => {
    const w = String(name).trim().split(/\s+/);
    return w.length > 1 ? (w[0][0] + w[1][0]).toUpperCase() : w[0].slice(0, 2);
  };
  function seatsHtml(s) {
    let h = "";
    for (let i = 0; i < s.max_people; i++) {
      const b = s.bookings[i];
      h += b ? `<span class="seat filled" title="${esc(personName(b.person_id))}">${esc(initials(personName(b.person_id)))}</span>`
             : `<span class="seat${i < s.min_people ? " req" : ""}" aria-hidden="true"></span>`;
    }
    return h;
  }
  function statusLabel(s, st) {
    const n = s.bookings.length;
    return { red: "Saknar " + (s.min_people - n), jour: "Ingen jour", full: "Fullt", green: "Bemannat", past: "Klart" }[st];
  }
  function cardHtml(s, compact = false) {
    const st = status(s);
    const names = s.bookings.map((b) => esc(personName(b.person_id))).join(", ");
    const pill = `<span class="pill" title="${countText(s)}">${statusLabel(s, st)}</span>`;
    const extra = `${s.is_jour ? '<span class="tag">JOUR</span>' : ""}${s.notes.length ? `<span class="noteic" title="Har anteckningar">${svg("note", 14)}</span>` : ""}`;
    const wx = wxShift(s);
    return `<div class="card st-${st}${isMine(s) ? " mine" : ""}" data-id="${s.id}">
      <div class="c-top"><div class="c-time">${timeRange(s)}</div>${compact ? "" : pill}</div>
      <div class="c-mid"><b>${esc(s.title)}</b>${compact ? "" : `<span class="place">· ${esc(s.place)}</span>`}${extra}
        ${compact ? `${wx}<span class="place">· ${esc(s.place)}</span>` : `<span class="spacer"></span>${wx}`}</div>
      <div class="c-seats">${seatsHtml(s)}${compact ? pill : `<span class="c-names">${names || (s.is_jour ? "Ingen har jouren" : "Ingen bokad")}</span>`}</div>
      ${isAdmin() && st !== "past" ? `<button class="fill-handle" type="button" aria-label="Fyll på med fler pass efter det här" title="Dra nedåt för att fylla på med fler pass">${svg("filldown", 14)}</button>` : ""}
    </div>`;
  }

  const SHIFT_MIME = "application/x-isg-shift";
  function wireCards(root) {
    const canDragShifts = isWeekView() && isAdmin();
    root.querySelectorAll(".card").forEach((c) => {
      const id = Number(c.dataset.id);
      c.onclick = () => openShift(id);
      const fh = c.querySelector(".fill-handle");
      if (fh) wireFillHandle(fh, c, id);
      if (canDragShifts) {
        c.draggable = true;
        c.title = "Dra till ett annat pass för att kopiera passets inställningar dit";
        c.addEventListener("dragstart", (e) => { if (fillDragging) { e.preventDefault(); return; } e.dataTransfer.setData(SHIFT_MIME, String(id)); e.dataTransfer.effectAllowed = "copy"; c.classList.add("dragging"); });
        c.addEventListener("dragend", () => c.classList.remove("dragging"));
      }
      c.addEventListener("dragover", (e) => { e.preventDefault(); c.classList.add("drop"); });
      c.addEventListener("dragleave", () => c.classList.remove("drop"));
      c.addEventListener("drop", async (e) => {
        e.preventDefault(); c.classList.remove("drop");
        const srcId = Number(e.dataTransfer.getData(SHIFT_MIME));
        if (srcId) { if (srcId !== id) copyShiftOnto(srcId, id); return; }
        const pid = Number(e.dataTransfer.getData("text/plain"));
        if (!pid) return;
        try { await rpc("book_shift", { p_shift: id, p_person: pid, p_actor: actor() }); toast(personName(pid) + " bokad ✓"); load(); } catch {}
      });
    });
  }

  function renderList() {
    const now = new Date();
    const end = addDays(startOfDay(now), S.listDays);
    let list = S.shifts.filter((s) => s.end > now && s.start < end);
    if (S.filter === "mine") list = list.filter(isMine);
    if (S.filter === "missing") list = list.filter((s) => status(s) === "red");
    const main = $("#main");
    if (S.filter === "mine" && !me()) {
      main.innerHTML = `<div class="empty">Välj vem du är (uppe till höger) för att se dina pass.</div>`;
      return;
    }
    let html = "", lastDay = "";
    const todayKey = dayKey(now);
    for (const s of list) {
      const k = dayKey(s.start);
      if (k !== lastDay) { html += `<div class="day${k === todayKey ? " today" : ""}">${k === todayKey ? "Idag · " : ""}${dayLabel(s.start)}${wxDay(s.start)}</div>`; lastDay = k; }
      html += cardHtml(s);
    }
    if (!list.length) html = `<div class="empty">${S.filter === "missing" ? "Alla pass är bemannade 🎉" : S.filter === "mine" ? "Du har inga bokade pass de närmaste veckorna." : "Inga pass upplagda ännu."}</div>`;
    html += `<button class="btn more" id="moreBtn">Visa längre fram</button>`;
    main.innerHTML = html;
    wireCards(main);
    $("#moreBtn").onclick = () => { S.listDays += 14; load(); };
  }

  // Kopiera ett pass inställningar till ett annat pass, men behåll målpassets datum
  async function copyShiftOnto(srcId, dstId) {
    const src = S.shifts.find((x) => x.id === srcId), dst = S.shifts.find((x) => x.id === dstId);
    if (!src || !dst) return;
    if (dst.end <= new Date() && !isAdmin()) return toast("Passet har passerat och är låst.", true);
    const start = new Date(dst.start);
    start.setHours(src.start.getHours(), src.start.getMinutes(), 0, 0);
    const end = new Date(start.getTime() + (src.end - src.start));
    const n = dst.bookings.length;
    const msg = `Ändra ${shortDay(dst.start)} ${timeRange(dst)} ${dst.title}\n` +
      `till ${shortDay(start)} ${hm(start)}–${hm(end)} ${src.title}?\n\n` +
      `Rubrik, arbete, plats, tider, antal, jour och beskrivning kopieras från ${shortDay(src.start)}.` +
      (n ? `\n${n} bokad(e) ligger kvar på passet.` : "");
    if (!confirm(msg)) return;
    try {
      await rpc("update_shift", {
        p_id: dstId, p_title: src.title, p_work_type: src.work_type, p_place: src.place,
        p_start: start.toISOString(), p_end: end.toISOString(),
        p_min: src.min_people, p_max: Math.max(src.max_people, n), p_jour: src.is_jour,
        p_desc: src.description || "", p_actor: actor(), p_pin: S.pin,
      });
      toast("Passet uppdaterat ✓");
      load();
    } catch {}
  }

  // Kopiera ett pass till en annan dag (samma klockslag och egenskaper, inga bokningar)
  async function copyShiftToDate(srcId, dateKey) {
    const src = S.shifts.find((x) => x.id === srcId);
    if (!src) return;
    const [y, mo, da] = dateKey.split("-").map(Number);
    const start = new Date(src.start); start.setFullYear(y, mo - 1, da);
    const end = new Date(start.getTime() + (src.end - src.start));
    if (end <= new Date()) return toast("Den tiden har redan passerat.", true);
    const clash = S.shifts.find((x) => x.start < end && x.end > start);
    const msg = `Kopiera ${src.title} ${timeRange(src)}\ntill ${dayLabel(start)} ${hm(start)}–${hm(end)}?\n\n` +
      `Rubrik, arbete, plats, antal, jour och beskrivning följer med. Inga bokningar.` +
      (clash ? `\n\nObs: krockar med ${clash.title} ${timeRange(clash)} samma dag.` : "");
    if (!confirm(msg)) return;
    try {
      await rpc("create_shift", {
        p_title: src.title, p_work_type: src.work_type, p_place: src.place,
        p_start: start.toISOString(), p_end: end.toISOString(),
        p_min: src.min_people, p_max: src.max_people, p_jour: src.is_jour,
        p_desc: src.description || "", p_actor: actor(),
      });
      toast("Passet kopierat ✓ – dra pilen under det för att fylla på dagen");
      load();
    } catch {}
  }

  function renderWeek() {
    const main = $("#main");
    const todayKey = dayKey(new Date());
    const chips = S.people.filter((p) => p.active)
      .map((p) => `<span class="chip${p.id === S.meId ? " me" : ""}" draggable="true" data-pid="${p.id}">${esc(p.name)}</span>`).join("");
    let cols = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(S.weekStart, i), k = dayKey(d);
      const items = S.shifts.filter((s) => dayKey(s.start) === k);
      const slot = isAdmin() && k >= todayKey
        ? `<div class="slot${items.length ? "" : " empty"}" data-date="${k}">${items.length ? "+ Släpp pass här" : "Dra ett pass hit för att kopiera det till den här dagen"}</div>` : "";
      cols += `<div class="wcol"><div class="whead${k === todayKey ? " today" : ""}">${shortDay(d)}${wxDay(d)}</div>${items.map((s) => cardHtml(s, true)).join("") || ""}${slot}</div>`;
    }
    main.innerHTML = `<div class="weekwrap">
      <aside class="names"><h3>Namn</h3>${chips}<button class="chip add" id="addNameChip">+ Namn</button>
      <p class="hint">Dra ett namn till ett pass för att boka.${isAdmin() ? "<br><br>Admin:<br>• Dra ett pass till ett annat pass för att kopiera inställningarna dit (datumet behålls).<br>• Dra ett pass till ett streckat mallkort för att kopiera det till den dagen.<br>• Dra pilen under ett pass nedåt för att fylla på fler pass." : ""}</p></aside>
      <div class="week">${cols}</div></div>`;
    main.querySelectorAll(".chip[data-pid]").forEach((c) => {
      c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.dataset.pid); e.dataTransfer.effectAllowed = "copy"; });
    });
    $("#addNameChip").onclick = () => openWho(true);
    wireCards(main);
    main.querySelectorAll(".slot").forEach((sl) => {
      const isShift = (e) => Array.from(e.dataTransfer?.types || []).includes(SHIFT_MIME);
      sl.addEventListener("dragover", (e) => { if (!isShift(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; sl.classList.add("over"); });
      sl.addEventListener("dragleave", () => sl.classList.remove("over"));
      sl.addEventListener("drop", (e) => {
        sl.classList.remove("over");
        const srcId = Number(e.dataTransfer.getData(SHIFT_MIME));
        if (!srcId) return;
        e.preventDefault();
        copyShiftToDate(srcId, sl.dataset.date);
      });
    });
  }

  // ---------- Modal ----------
  let openModalFn = null, modalLocked = false, modalDirty = false;
  // locked = formulär: stängs inte av klick utanför eller Esc, och × frågar om osparade ändringar
  function modal(html, refresher = null, locked = false) {
    const root = $("#modalRoot");
    root.innerHTML = `<div class="overlay"><div class="modal"><button class="x" aria-label="Stäng">×</button>${html}</div></div>`;
    const ov = $(".overlay", root);
    modalLocked = locked; modalDirty = false;
    ov.addEventListener("click", (e) => { if (e.target === ov && !modalLocked) closeModal(); });
    if (locked) ov.addEventListener("input", () => { modalDirty = true; });
    $(".x", root).onclick = () => {
      if (modalLocked && modalDirty && !confirm("Stäng utan att spara ändringarna?")) return;
      closeModal();
    };
    openModalFn = refresher;
    return $(".modal", root);
  }
  function closeModal() { $("#modalRoot").innerHTML = ""; openModalFn = null; modalLocked = false; modalDirty = false; }
  function refreshOpenModal() { if (openModalFn && !modalLocked) openModalFn(); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modalLocked) closeModal(); });

  // ---------- Vem är du ----------
  function openWho(focusAdd = false) {
    const draw = () => {
      const active = S.people.filter((p) => p.active);
      const m = modal(`<h2>Vem är du?</h2><div class="meta">Telefonen kommer ihåg ditt val.</div>
        <div class="who">${active.map((p) => `<button data-pid="${p.id}" class="${p.id === S.meId ? "on" : ""}">${esc(p.name)}${isAdmin() ? `<span class="del" data-del="${p.id}">Ta bort</span>` : ""}</button>`).join("")}</div>
        <section><h4>Inte med i listan?</h4><div class="row"><input type="text" id="newName" maxlength="40" placeholder="Ditt namn, t.ex. Anders N" style="flex:1"><button class="btn primary" id="addName">Lägg till</button></div></section>`);
      m.querySelectorAll("[data-pid]").forEach((b) => b.onclick = async (e) => {
        const del = e.target.closest("[data-del]");
        if (del) {
          e.stopPropagation();
          const id = Number(del.dataset.del);
          if (!confirm(`Ta bort ${personName(id)} ur listan? Kommande bokningar tas bort, historiken sparas.`)) return;
          try { await rpc("remove_person", { p_id: id, p_pin: S.pin, p_actor: actor() }); if (id === S.meId) setMe(null); await load(); draw(); } catch {}
          return;
        }
        setMe(Number(b.dataset.pid)); closeModal(); render();
      });
      const add = async () => {
        const name = $("#newName").value.trim();
        if (!name) return;
        try { const id = await rpc("add_person", { p_name: name, p_actor: me()?.name || name }); if (!me()) setMe(id); await load(); closeModal(); toast(name + " tillagd ✓"); } catch {}
      };
      $("#addName").onclick = add;
      $("#newName").onkeydown = (e) => { if (e.key === "Enter") add(); };
      if (focusAdd) $("#newName").focus();
    };
    draw();
  }
  function setMe(id) { S.meId = id; store.set("isg_me", id ? String(id) : null); renderHeader(); }

  // ---------- Admin ----------
  function openAdmin() {
    if (isAdmin()) {
      const m = modal(`<h2>Adminläge är på</h2><div class="meta">Du kan ändra och ta bort alla pass och ta bort namn.</div>
        <div style="display:grid;gap:8px">
          <button class="btn big" id="admWt">Typ av arbete – redigera listan</button>
          <button class="btn big" id="admTpl">${svg("template", 16)} Veckomallar</button>
          <button class="btn big" id="adminOff">Lämna adminläge</button>
        </div>`);
      $("#admWt", m).onclick = () => openWorkTypes();
      $("#admTpl", m).onclick = () => openTemplates();
      $("#adminOff", m).onclick = () => { S.pin = null; sess.set("isg_pin", null); closeModal(); render(); };
      return;
    }
    const m = modal(`<h2>Admin</h2><label>PIN-kod</label><input type="password" inputmode="numeric" id="pin" autocomplete="off" maxlength="12">
      <div style="margin-top:12px"><button class="btn primary big" id="pinOk">Lås upp</button></div>`);
    const go = async () => {
      const pin = $("#pin", m).value.trim();
      try {
        const ok = await rpc("verify_pin", { p_pin: pin });
        if (!ok) return toast("Fel PIN-kod", true);
        S.pin = pin; sess.set("isg_pin", pin); closeModal(); render(); toast("Adminläge på");
      } catch {}
    };
    $("#pinOk", m).onclick = go;
    $("#pin", m).onkeydown = (e) => { if (e.key === "Enter") go(); };
    $("#pin", m).focus();
  }

  // ---------- Pass ----------
  function openShift(id) {
    const draw = () => {
      const s = S.shifts.find((x) => x.id === id);
      if (!s) { closeModal(); return; }
      const st = status(s), locked = st === "past";
      const m0 = me(), mine = isMine(s);
      const canEdit = isAdmin() || (!locked && s.created_by && s.created_by === m0?.name);
      const others = S.people.filter((p) => p.active && !s.bookings.some((b) => b.person_id === p.id));
      const stText = { red: "Saknar folk", green: "Bemannat", full: "Fullt", jour: "Ingen har jouren", past: "Passerat – låst" }[st];
      const lastUnbook = openShift.lastUnbook === id;
      const m = modal(`
        <h2>${esc(s.title)}${s.is_jour ? ' <span class="tag">JOUR</span>' : ""}</h2>
        <div class="meta">${dayLabel(s.start)} · ${timeRange(s)}<br>${esc(s.place)} · ${esc(s.work_type)}${s.created_by ? ` · upplagt av ${esc(s.created_by)}` : ""}</div>
        ${s.description ? `<div class="note">${esc(s.description)}</div>` : ""}
        <section><h4>Bokade · ${countText(s)} · ${stText}</h4>
          ${s.bookings.map((b) => `<div class="booked"><span><span class="seat filled">${esc(initials(personName(b.person_id)))}</span><b>${esc(personName(b.person_id))}</b></span>${!locked ? `<button class="rm" data-un="${b.person_id}">Avboka</button>` : ""}</div>`).join("") || `<div class="meta">Ingen bokad ännu.</div>`}
          ${lastUnbook && st !== "past" && s.bookings.length < s.min_people ? `<div class="alert">Passet saknar folk nu. <button class="btn" id="shareThis">📣 Dela i Messenger</button></div>` : ""}
          ${!locked ? `
            <div style="margin-top:10px">${m0
              ? (mine ? `<button class="btn big" id="unMe">Avboka mig</button>`
                      : `<button class="btn primary big" id="bookMe" ${s.bookings.length >= s.max_people ? "disabled" : ""}>Boka mig (${esc(m0.name)})</button>`)
              : `<button class="btn primary big" id="pickMe">Välj vem du är för att boka</button>`}</div>
            ${others.length && s.bookings.length < s.max_people ? `<div class="row" style="margin-top:8px"><select id="otherSel" style="flex:1"><option value="">Boka in någon annan…</option>${others.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select><button class="btn" id="bookOther">Boka</button></div>` : ""}` : ""}
        </section>
        ${wxDetail(s)}
        <section><h4>Anteckningar</h4>
          ${s.notes.map((n) => `<div class="note">${esc(n.body)}<small>${esc(personName(n.person_id))} · ${shortDay(new Date(n.created_at))} ${hm(new Date(n.created_at))}</small></div>`).join("") || `<div class="meta">Inga anteckningar.</div>`}
          ${mine ? `<textarea id="noteTxt" maxlength="1000" placeholder="T.ex. Tankvagnen läcker vid kopplingen"></textarea><div style="margin-top:6px"><button class="btn primary" id="noteSave">Spara anteckning</button></div>`
                 : `<div class="meta" style="font-size:13px">Boka dig på passet för att skriva anteckningar.</div>`}
        </section>
        <section class="row">
          ${!locked ? `<button class="btn" id="calBtn">📅 Lägg i kalender</button><button class="btn" id="shareOne">📣 Dela</button>` : ""}
          <span class="spacer"></span>
          ${isAdmin() && !locked ? `<button class="btn" id="fillBtn">${svg("filldown", 14)} Fyll på nedåt</button>` : ""}
          ${canEdit ? `<button class="btn" id="editBtn">Ändra</button><button class="btn danger" id="delBtn">Ta bort</button>` : ""}
        </section>`, draw);

      const act = async (fn, args, ok) => { try { await rpc(fn, args); if (ok) toast(ok); await load(); } catch {} };
      $("#pickMe", m)?.addEventListener("click", () => openWho());
      $("#bookMe", m)?.addEventListener("click", () => act("book_shift", { p_shift: id, p_person: S.meId, p_actor: actor() }, "Bokad ✓"));
      $("#unMe", m)?.addEventListener("click", () => unbook(s, S.meId));
      m.querySelectorAll("[data-un]").forEach((b) => b.onclick = () => unbook(s, Number(b.dataset.un)));
      $("#bookOther", m)?.addEventListener("click", () => {
        const pid = Number($("#otherSel", m).value); if (!pid) return;
        act("book_shift", { p_shift: id, p_person: pid, p_actor: actor() }, personName(pid) + " bokad ✓");
      });
      $("#noteSave", m)?.addEventListener("click", () => {
        const body = $("#noteTxt", m).value.trim(); if (!body) return;
        act("add_note", { p_shift: id, p_person: S.meId, p_body: body }, "Anteckning sparad");
      });
      $("#calBtn", m)?.addEventListener("click", () => downloadIcs(s));
      $("#shareOne", m)?.addEventListener("click", () => share(shiftShareText(s)));
      $("#shareThis", m)?.addEventListener("click", () => share(`Jag kan inte ta ${shortDay(s.start)} ${timeRange(s)} ${s.title} – någon som kan? (${countText(s)})\n${location.href.split("#")[0]}`));
      $("#editBtn", m)?.addEventListener("click", () => openShiftForm(s));
      $("#fillBtn", m)?.addEventListener("click", () => openFillDown(s.id, 1));
      $("#delBtn", m)?.addEventListener("click", async () => {
        const n = s.bookings.length;
        if (!confirm(`Ta bort passet ${shortDay(s.start)} ${timeRange(s)} ${s.title}?${n ? `\n\n${n} person(er) är bokade och tas bort från passet.` : ""}`)) return;
        try { await rpc("delete_shift", { p_id: id, p_actor: actor(), p_pin: S.pin }); closeModal(); toast("Passet borttaget"); load(); } catch {}
      });
    };
    openShift.lastUnbook = null;
    draw();
  }

  async function unbook(s, pid) {
    try {
      await rpc("unbook_shift", { p_shift: s.id, p_person: pid, p_actor: actor() });
      toast(personName(pid) + " avbokad");
      openShift.lastUnbook = (s.start - Date.now() < DAY) ? s.id : null;
      await load();
    } catch {}
  }

  // ---------- Skapa / ändra pass ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function openShiftForm(s = null) {
    const isNew = !s;
    const def = s ? null : { start: "18:00", end: "20:00" };
    const d0 = s ? s.start : new Date();
    const m = modal(`<h2>${isNew ? "Nytt pass" : "Ändra pass"}</h2>
      <label>Typ av arbete</label><select id="fType">${[...S.workTypes.map((w) => w.name), ...(s && !S.workTypes.some((w) => w.name === s.work_type) ? [s.work_type] : [])]
        .map((t) => `<option ${s?.work_type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      <label>Rubrik (valfritt)</label><input type="text" id="fTitle" maxlength="60" placeholder="T.ex. Kvällsspolning" value="${esc(s?.title && s.title !== s.work_type ? s.title : "")}">
      <label>Plats</label><select id="fPlace">${PLACES.map((p) => `<option ${s?.place === p ? "selected" : ""}>${p}</option>`).join("")}</select>
      <label>Datum</label><input type="date" id="fDate" value="${dayKey(d0)}">
      <div class="grid2"><div><label>Start</label><input type="time" id="fStart" value="${s ? toTimeInput(s.start) : def.start}"></div>
        <div><label>Slut</label><input type="time" id="fEnd" value="${s ? toTimeInput(s.end) : def.end}"></div></div>
      <div class="grid2"><div><label>Minst antal</label><input type="number" id="fMin" min="1" max="10" value="${s?.min_people ?? 1}"></div>
        <div><label>Max antal</label><input type="number" id="fMax" min="1" max="10" value="${s?.max_people ?? 3}"></div></div>
      <label class="check"><input type="checkbox" id="fJour" ${s?.is_jour ? "checked" : ""}> Snöjour – röj om det snöar</label>
      <label>Beskrivning (valfritt)</label><textarea id="fDesc" maxlength="500" placeholder="T.ex. Bara om det snöat mer än 5 cm">${esc(s?.description || "")}</textarea>
      ${isNew ? `<label class="check"><input type="checkbox" id="fBookMe" ${me() ? "checked" : "disabled"}> Boka mig direkt${me() ? "" : " (välj vem du är först)"}</label>` : ""}
      <div style="margin-top:14px"><button class="btn primary big" id="fSave">${isNew ? "Lägg upp pass" : "Spara ändringar"}</button></div>`, null, true);

    const applyDefaults = () => {
      const [mn, mx] = wtDefaults($("#fType", m).value);
      $("#fMin", m).value = mn; $("#fMax", m).value = mx;
    };
    if (isNew) applyDefaults();
    $("#fType", m).onchange = applyDefaults;
    $("#fJour", m).onchange = (e) => {
      if (e.target.checked && isNew) { if (S.workTypes.some((w) => w.name === "Snöröjning")) { $("#fType", m).value = "Snöröjning"; applyDefaults(); } if (!$("#fTitle", m).value) $("#fTitle", m).value = "Snöjour"; }
    };
    $("#fSave", m).onclick = async () => {
      const date = $("#fDate", m).value, st = $("#fStart", m).value, et = $("#fEnd", m).value;
      if (!date || !st || !et) return toast("Fyll i datum och tider", true);
      const start = new Date(`${date}T${st}`);
      let end = new Date(`${date}T${et}`);
      if (end <= start) end = addDays(end, 1); // t.ex. 22:00–00:00
      const min = Number($("#fMin", m).value), max = Number($("#fMax", m).value);
      if (!(min >= 1 && max >= min && max <= 10)) return toast("Kontrollera minst/max antal", true);
      const args = {
        p_title: $("#fTitle", m).value.trim(), p_work_type: $("#fType", m).value, p_place: $("#fPlace", m).value,
        p_start: start.toISOString(), p_end: end.toISOString(), p_min: min, p_max: max,
        p_jour: $("#fJour", m).checked, p_desc: $("#fDesc", m).value, p_actor: actor(),
      };
      try {
        if (isNew) {
          const id = await rpc("create_shift", args);
          if ($("#fBookMe", m)?.checked && S.meId) {
            try { await rpc("book_shift", { p_shift: id, p_person: S.meId, p_actor: actor() }); } catch {}
          }
          toast("Passet är upplagt ✓");
        } else {
          await rpc("update_shift", { p_id: s.id, ...args, p_pin: S.pin });
          toast("Ändringar sparade ✓");
        }
        closeModal(); load();
      } catch {}
    };
  }

  // ---------- Dela & kalender ----------
  const appUrl = () => location.href.split("#")[0].split("?")[0];
  function shiftShareText(s) {
    const st = status(s);
    return `${s.is_jour ? "Snöjour" : "Pass"}: ${shortDay(s.start)} ${timeRange(s)} ${s.title} (${s.place}) – ${countText(s)}${st === "red" || st === "jour" ? " – saknar folk!" : ""}\nBoka här: ${appUrl()}`;
  }
  function shareOpenShifts() {
    const now = new Date(), end = addDays(startOfDay(now), 14);
    const open = S.shifts.filter((s) => s.end > now && s.start < end && (status(s) === "red" || status(s) === "jour"));
    if (!open.length) return toast("Alla pass de närmaste två veckorna är bemannade 🎉");
    const lines = open.map((s) => `• ${shortDay(s.start)} ${timeRange(s)} ${s.title}${s.is_jour ? " (snöjour)" : ""} – ${countText(s)}`);
    share(`❄️ IS-gruppen – pass som saknar folk:\n${lines.join("\n")}\n\nBoka här: ${appUrl()}`);
  }
  async function share(text) {
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(text); toast("Texten är kopierad – klistra in i Messenger"); }
    catch {
      const m = modal(`<h2>Kopiera texten</h2><textarea style="min-height:180px">${esc(text)}</textarea>`);
      $("textarea", m).select();
    }
  }
  function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsEsc(t) { return String(t).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => "\\" + c); }
  function downloadIcs(s) {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//IS-gruppen Borlange Bandy//SV", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:isg-${s.id}@isgruppen`, `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(s.start)}`, `DTEND:${icsDate(s.end)}`,
      `SUMMARY:${icsEsc("IS-gruppen: " + s.title)}`,
      `LOCATION:${icsEsc(s.place + ", Borlänge Bandy")}`,
      `DESCRIPTION:${icsEsc((s.description ? s.description + "\n" : "") + appUrl())}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:IS-gruppen pass", "TRIGGER:-PT1H", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `isgruppen-${dayKey(s.start)}-${toTimeInput(s.start).replace(":", "")}.ics`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }



  // ---------- Fyll på nedåt ----------
  // Dra handtaget längst ner på ett pass nedåt: varje "kortlängd" = ett nytt pass direkt efter.
  let fillDragging = false;
  function wireFillHandle(fh, card, id) {
    fh.addEventListener("click", (e) => { e.stopPropagation(); if (!fh._dragged) openFillDown(id, 1); fh._dragged = false; });
    fh.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      fillDragging = true; fh._dragged = false;
      fh.setPointerCapture(e.pointerId);
      const r = card.getBoundingClientRect();
      const step = Math.max(60, r.height + 10);
      const ghost = document.createElement("div");
      ghost.className = "fill-ghost";
      Object.assign(ghost.style, { left: r.left + "px", top: r.bottom + 4 + "px", width: r.width + "px", height: "0px" });
      document.body.appendChild(ghost);
      const startY = e.clientY;
      let count = 0;
      const move = (ev) => {
        const dy = Math.max(0, ev.clientY - startY);
        if (dy > 8) fh._dragged = true;
        count = Math.min(12, Math.round(dy / step));
        ghost.style.height = dy + "px";
        ghost.textContent = count ? `+${count} pass` : "Dra längre…";
      };
      const up = () => {
        fh.removeEventListener("pointermove", move);
        fh.removeEventListener("pointerup", up);
        fh.removeEventListener("pointercancel", up);
        ghost.remove(); fillDragging = false;
        if (fh._dragged && count > 0) openFillDown(id, count);
      };
      fh.addEventListener("pointermove", move);
      fh.addEventListener("pointerup", up);
      fh.addEventListener("pointercancel", up);
    });
  }

  function overlaps(a0, a1, b0, b1) { return a0 < b1 && a1 > b0; }
  function fillPlan(src, count, durMin, skipConflicts) {
    const dayEnd = addDays(startOfDay(src.start), 1);
    const others = S.shifts.filter((x) => x.id !== src.id);
    const plan = [];
    let t = new Date(src.end);
    for (let i = 0; i < count; i++) {
      if (t >= dayEnd) break;
      let e = new Date(t.getTime() + durMin * 60000), cut = false;
      if (e > dayEnd) { e = new Date(dayEnd); cut = true; }
      const clash = others.find((x) => overlaps(t, e, x.start, x.end));
      plan.push({ start: new Date(t), end: e, cut, clash, skip: !!clash && skipConflicts });
      t = e;
    }
    return plan;
  }

  function openFillDown(id, count = 1) {
    const src = S.shifts.find((x) => x.id === id);
    if (!src) return;
    const dur0 = Math.round((src.end - src.start) / 60000);
    const dayEnd = addDays(startOfDay(src.start), 1);
    if (src.end >= dayEnd) return toast("Passet slutar vid midnatt – det finns ingen plats efter det samma dag.", true);
    const m = modal(`<h2>Fyll på nedåt</h2>
      <div class="meta">Nya pass direkt efter <b>${shortDay(src.start)} ${timeRange(src)} ${esc(src.title)}</b>.
        Rubrik, arbete, plats, antal, jour och beskrivning kopieras. Inga bokningar följer med.</div>
      <div class="grid2">
        <div><label for="fdCount">Antal nya pass</label><input type="number" id="fdCount" min="1" max="12" value="${count}"></div>
        <div><label>Längd per pass</label><div class="row" style="flex-wrap:nowrap">
          <input type="number" id="fdH" min="0" max="24" value="${Math.floor(dur0 / 60)}" aria-label="Timmar" style="width:70px"> <span>tim</span>
          <select id="fdM" aria-label="Minuter" style="width:80px">${[0, 15, 30, 45].map((x) => `<option ${dur0 % 60 === x ? "selected" : ""}>${x}</option>`).join("")}</select> <span>min</span>
        </div></div>
      </div>
      <p class="gnote">Förvalt: samma längd som passet du drog (${Math.floor(dur0 / 60)} h${dur0 % 60 ? " " + (dur0 % 60) + " min" : ""}).</p>
      <label class="check"><input type="checkbox" id="fdSkip" checked> Hoppa över tider som krockar med pass som redan finns</label>
      <section><h4>Det här skapas</h4><div id="fdList"></div></section>
      <button class="btn primary big" id="fdGo">Skapa pass</button>`, null, true);
    const read = () => {
      const c = Math.max(1, Math.min(12, Number($("#fdCount", m).value) || 1));
      const d = (Number($("#fdH", m).value) || 0) * 60 + Number($("#fdM", m).value);
      return { c, d, skip: $("#fdSkip", m).checked };
    };
    let plan = [];
    const draw = () => {
      const { c, d, skip } = read();
      if (d < 15) { $("#fdList", m).innerHTML = `<div class="meta">Längden måste vara minst 15 minuter.</div>`; $("#fdGo", m).disabled = true; return; }
      plan = fillPlan(src, c, d, skip);
      const make = plan.filter((p) => !p.skip);
      $("#fdList", m).innerHTML = plan.map((p) => `<div class="fd-row${p.skip ? " skip" : ""}">
          <b class="num">${hm(p.start)}–${hm(p.end)}</b> ${esc(src.title)}
          ${p.skip ? `<span class="gnote">hoppas över – krockar med ${esc(p.clash.title)} ${timeRange(p.clash)}</span>`
                   : p.clash ? `<span class="gnote">krockar med ${esc(p.clash.title)} ${timeRange(p.clash)}</span>` : ""}
          ${p.cut ? `<span class="gnote">förkortat – slutar vid midnatt</span>` : ""}</div>`).join("")
        + (plan.length < c ? `<div class="gnote">Fick bara plats med ${plan.length} pass före midnatt.</div>` : "");
      $("#fdGo", m).disabled = !make.length;
      $("#fdGo", m).textContent = make.length ? `Skapa ${make.length} pass` : "Inget att skapa";
    };
    ["#fdCount", "#fdH", "#fdM", "#fdSkip"].forEach((q) => $(q, m).addEventListener("input", draw));
    $("#fdM", m).addEventListener("change", draw);
    draw();
    $("#fdGo", m).onclick = async () => {
      const make = plan.filter((p) => !p.skip);
      $("#fdGo", m).disabled = true;
      let ok = 0;
      for (const p of make) {
        try {
          await rpc("create_shift", {
            p_title: src.title, p_work_type: src.work_type, p_place: src.place,
            p_start: p.start.toISOString(), p_end: p.end.toISOString(),
            p_min: src.min_people, p_max: src.max_people, p_jour: src.is_jour,
            p_desc: src.description || "", p_actor: actor(),
          });
          ok++;
        } catch { break; }
      }
      closeModal();
      if (ok) toast(`${ok} pass skapade ✓`);
      load();
    };
  }


  // ---------- Veckomallar (admin) ----------
  const WD_NAMES = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
  function weekOptions(selectedKey, from = -2, to = 30) {
    const base = startOfWeek(new Date());
    let h = "";
    for (let i = from; i <= to; i++) {
      const mon = addDays(base, 7 * i), sun = addDays(mon, 6), k = dayKey(mon);
      h += `<option value="${k}" ${k === selectedKey ? "selected" : ""}>v.${isoWeek(mon)} · ${mon.getDate()} ${MONTHS[mon.getMonth()]} – ${sun.getDate()} ${MONTHS[sun.getMonth()]}${i === 0 ? " (denna vecka)" : ""}</option>`;
    }
    return h;
  }
  const parseDayKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const pad2 = (n) => String(n).padStart(2, "0");
  const durTxt = (min) => `${Math.floor(min / 60)} h${min % 60 ? " " + (min % 60) + " min" : ""}`;
  function itemEnd(it) {
    const [h, m] = it.start_time.split(":").map(Number);
    const e = h * 60 + m + it.duration_min;
    return `${pad2(Math.floor(e / 60) % 24)}:${pad2(e % 60)}`;
  }

  async function fetchTemplates() {
    const { data, error } = await sb.from("templates").select("*, template_items(*)").order("name");
    if (error) throw error;
    return data.map((t) => ({ ...t, items: (t.template_items || []).sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time)) }));
  }
  async function fetchWeekShifts(mondayKey) {
    const mon = parseDayKey(mondayKey);
    const { data, error } = await sb.from("shifts").select("*").gte("start_at", mon.toISOString())
      .lt("start_at", addDays(mon, 7).toISOString()).order("start_at");
    if (error) throw error;
    return data.map((x) => ({ ...x, start: new Date(x.start_at), end: new Date(x.end_at) }));
  }

  async function openTemplates() {
    let tpls;
    try { tpls = await fetchTemplates(); }
    catch (e) {
      modal(`<h2>Veckomallar</h2><div class="alert">Mallfunktionen är inte installerad i databasen än.
        Kör filen <b>supabase-v2-mallar.sql</b> i Supabase → SQL Editor (se guiden i mappen).</div>`);
      return;
    }
    const curKey = dayKey(isWeekView() ? S.weekStart : startOfWeek(new Date()));
    const m = modal(`<h2>${svg("template", 20)} Veckomallar</h2>
      <div class="meta">Spara en vecka som mall och lägg ut den på kommande veckor. Utlagda pass blir vanliga pass som kan ändras var för sig.</div>

      <section><h4>Mallar</h4>
        ${tpls.length ? tpls.map((t) => `<div class="tpl-row">
            <div><b>${esc(t.name)}</b><div class="gnote">${t.items.length} pass · ändrad ${shortDay(new Date(t.updated_at))}</div></div>
            <span class="spacer"></span>
            <button class="btn primary" data-apply="${t.id}">Lägg ut</button>
            <button class="btn" data-show="${t.id}">Visa</button>
          </div>`).join("") : `<div class="meta">Inga mallar än. Spara en vecka som mall nedan.</div>`}
      </section>

      <section><h4>Spara en vecka som mall</h4>
        <label for="svWeek">Vecka</label><select id="svWeek">${weekOptions(curKey, -8, 30)}</select>
        <div id="svInfo" class="gnote"></div>
        <label for="svTarget">Spara som</label>
        <select id="svTarget"><option value="">Ny mall</option>${tpls.map((t) => `<option value="${t.id}">Ersätt: ${esc(t.name)}</option>`).join("")}</select>
        <div id="svNameWrap"><label for="svName">Namn på mallen</label><input type="text" id="svName" maxlength="60" placeholder="T.ex. Normalvecka"></div>
        <div style="margin-top:10px"><button class="btn primary" id="svGo">Spara som mall</button></div>
      </section>

      <section><h4>Rensa veckor</h4>
        <div class="grid2">
          <div><label for="clWeek">Från vecka</label><select id="clWeek">${weekOptions(curKey, 0, 30)}</select></div>
          <div><label for="clN">Antal veckor</label><input type="number" id="clN" min="1" max="26" value="1"></div>
        </div>
        <label class="check"><input type="checkbox" id="clBooked"> Ta bort även pass där någon är bokad</label>
        <p class="gnote">Pass som redan har passerat rörs aldrig.</p>
        <div style="margin-top:6px"><button class="btn danger" id="clGo">${svg("trash", 14)} Rensa</button></div>
      </section>`);

    m.querySelectorAll("[data-apply]").forEach((b) => b.onclick = () => openApplyTemplate(tpls.find((t) => t.id === Number(b.dataset.apply))));
    m.querySelectorAll("[data-show]").forEach((b) => b.onclick = () => openTemplateView(Number(b.dataset.show)));

    // Spara vecka som mall
    let weekShifts = [];
    const refreshInfo = async () => {
      $("#svInfo", m).textContent = "Hämtar…";
      try {
        weekShifts = await fetchWeekShifts($("#svWeek", m).value);
        $("#svInfo", m).textContent = weekShifts.length ? `${weekShifts.length} pass den veckan kommer med i mallen (inga bokningar).` : "Den veckan har inga pass.";
      } catch { $("#svInfo", m).textContent = "Kunde inte hämta veckan."; }
    };
    $("#svWeek", m).onchange = refreshInfo;
    $("#svTarget", m).onchange = () => {
      const t = tpls.find((x) => x.id === Number($("#svTarget", m).value));
      $("#svName", m).value = t ? t.name : "";
    };
    refreshInfo();
    $("#svGo", m).onclick = async () => {
      if (!weekShifts.length) return toast("Veckan har inga pass att spara.", true);
      const replaceId = Number($("#svTarget", m).value) || null;
      const name = $("#svName", m).value.trim();
      if (!name) return toast("Ge mallen ett namn.", true);
      if (replaceId && !confirm(`Ersätta innehållet i mallen "${name}" med ${weekShifts.length} pass från den valda veckan?`)) return;
      const items = weekShifts.map((x) => ({
        weekday: ((x.start.getDay() + 6) % 7) + 1, start_time: toTimeInput(x.start),
        duration_min: Math.round((x.end - x.start) / 60000), title: x.title, work_type: x.work_type, place: x.place,
        min_people: x.min_people, max_people: x.max_people, is_jour: x.is_jour, description: x.description || "",
      }));
      try {
        await rpc("save_template", { p_name: name, p_items: items, p_replace_id: replaceId, p_pin: S.pin, p_actor: actor() });
        toast(replaceId ? "Mallen uppdaterad ✓" : "Mallen sparad ✓");
        openTemplates();
      } catch {}
    };

    // Rensa veckor
    $("#clGo", m).onclick = async () => {
      const k = $("#clWeek", m).value, n = Math.max(1, Math.min(26, Number($("#clN", m).value) || 1));
      const booked = $("#clBooked", m).checked;
      const mon = parseDayKey(k);
      if (!confirm(`Rensa ${n} vecka/veckor från v.${isoWeek(mon)}?\n\n${booked ? "ALLA kommande pass tas bort – även där någon är bokad." : "Obokade pass tas bort. Pass där någon är bokad ligger kvar."}`)) return;
      try {
        const r = await rpc("clear_weeks", { p_monday: k, p_weeks: n, p_include_booked: booked, p_pin: S.pin, p_actor: actor() });
        toast(`${r.removed} pass borttagna${r.kept_booked ? ` · ${r.kept_booked} bokade ligger kvar` : ""}`);
        load();
      } catch {}
    };
  }

  function openApplyTemplate(t) {
    const nextKey = dayKey(addDays(isWeekView() ? S.weekStart : startOfWeek(new Date()), 7));
    const m = modal(`<h2>Lägg ut "${esc(t.name)}"</h2>
      <div class="meta">${t.items.length} pass per vecka.</div>
      <div class="grid2">
        <div><label for="apWeek">Från vecka</label><select id="apWeek">${weekOptions(nextKey, 0, 30)}</select></div>
        <div><label for="apN">Antal veckor</label><input type="number" id="apN" min="1" max="26" value="4"></div>
      </div>
      <div id="apRange" class="gnote"></div>
      <label class="check"><input type="radio" name="apMode" value="add" checked> Lägg till – hoppa över tider som krockar med pass som redan finns</label>
      <label class="check"><input type="radio" name="apMode" value="replace"> Ersätt – ta först bort obokade pass i veckorna (bokade pass ligger kvar)</label>
      <div style="margin-top:14px"><button class="btn primary big" id="apGo">Lägg ut mallen</button></div>`, null, true);
    const range = () => {
      const k = $("#apWeek", m).value, n = Math.max(1, Math.min(26, Number($("#apN", m).value) || 1));
      const mon = parseDayKey(k), last = addDays(mon, 7 * n - 1);
      $("#apRange", m).textContent = `v.${isoWeek(mon)}–v.${isoWeek(last)} (${mon.getDate()} ${MONTHS[mon.getMonth()]} – ${last.getDate()} ${MONTHS[last.getMonth()]}) · upp till ${t.items.length * n} pass`;
      return { k, n };
    };
    $("#apWeek", m).onchange = range; $("#apN", m).oninput = range; range();
    $("#apGo", m).onclick = async () => {
      const { k, n } = range();
      const replace = m.querySelector("input[name=apMode]:checked").value === "replace";
      if (replace && !confirm("Obokade pass i de valda veckorna tas bort innan mallen läggs ut. Fortsätta?")) return;
      $("#apGo", m).disabled = true;
      try {
        const r = await rpc("apply_template", { p_template: t.id, p_monday: k, p_weeks: n, p_replace: replace, p_pin: S.pin, p_actor: actor() });
        closeModal();
        toast(`${r.created} pass skapade${r.skipped ? ` · ${r.skipped} krockar hoppades över` : ""}${r.removed ? ` · ${r.removed} obokade ersattes` : ""}`);
        if (isWeekView()) S.weekStart = parseDayKey(k);
        load();
      } catch { $("#apGo", m).disabled = false; }
    };
  }

  async function openTemplateView(id) {
    let t;
    try { t = (await fetchTemplates()).find((x) => x.id === id); } catch { return toast("Kunde inte hämta mallen", true); }
    if (!t) return openTemplates();
    let rows = "", lastWd = 0;
    for (const it of t.items) {
      if (it.weekday !== lastWd) { rows += `<div class="day" style="margin:14px 0 4px">${WD_NAMES[it.weekday - 1]}</div>`; lastWd = it.weekday; }
      rows += `<div class="fd-row"><b class="num">${it.start_time.slice(0, 5)}–${itemEnd(it)}</b> ${esc(it.title)}
        <span class="gnote">${esc(it.place)} · ${it.min_people === it.max_people ? it.max_people : it.min_people + "–" + it.max_people} pers${it.is_jour ? " · JOUR" : ""}</span>
        <span class="spacer"></span><button class="rm-item" data-del="${it.id}" aria-label="Ta bort ur mallen">${svg("trash", 15)}</button></div>`;
    }
    const m = modal(`<h2>Mall: ${esc(t.name)}</h2>
      <div class="row"><input type="text" id="tvName" maxlength="60" value="${esc(t.name)}" style="flex:1"><button class="btn" id="tvRename">Byt namn</button></div>
      <section><h4>${t.items.length} pass per vecka</h4>${rows || `<div class="meta">Mallen är tom.</div>`}</section>
      <p class="gnote">Vill du ändra tider eller lägga till pass? Lägg ut mallen på en tom vecka, ändra i veckovyn
        (dra, fyll på nedåt, kopiera till dag) och spara sedan veckan som mall igen med <i>Ersätt</i>.</p>
      <section class="row">
        <button class="btn" id="tvBack">‹ Tillbaka</button><span class="spacer"></span>
        <button class="btn primary" id="tvApply">Lägg ut</button>
        <button class="btn danger" id="tvDel">${svg("trash", 14)} Ta bort mallen</button>
      </section>`);
    $("#tvBack", m).onclick = () => openTemplates();
    $("#tvApply", m).onclick = () => openApplyTemplate(t);
    $("#tvRename", m).onclick = async () => {
      const name = $("#tvName", m).value.trim(); if (!name) return;
      try { await rpc("rename_template", { p_id: t.id, p_name: name, p_pin: S.pin, p_actor: actor() }); toast("Namnet ändrat ✓"); openTemplateView(t.id); } catch {}
    };
    $("#tvDel", m).onclick = async () => {
      if (!confirm(`Ta bort mallen "${t.name}"? Pass som redan lagts ut påverkas inte.`)) return;
      try { await rpc("delete_template", { p_id: t.id, p_pin: S.pin, p_actor: actor() }); toast("Mallen borttagen"); openTemplates(); } catch {}
    };
    m.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      try { await rpc("delete_template_item", { p_id: Number(b.dataset.del), p_pin: S.pin }); openTemplateView(t.id); } catch {}
    });
  }


  // ---------- Isguider (arbetsinstruktioner) ----------
  // Standardinnehåll. När admin har sparat i appen används versionen i databasen (app_content.ice_guides).
  const DEFAULT_ICE_GUIDES = [
    {
      chapter: "1. Uppspolning av bandyplan",
      sections: [
        {
          id: "1.1", title: "Tankspolning", open: true,
          intro: "Banan spolas med traktor och tankbil. Tanken rymmer 5 000 liter.",
          goal: "Cirka 2–3 cm is och en yta helt fri från grus. Det brukar ta 25–30 vändor.",
          warning: "Isen måste frysa ordentligt mellan varje vända. Vänta hellre lite för länge än för kort.",
          steps: [
            { title: "Starta traktorn", items: [
              "Slå på huvudströmbrytaren med flärpen.",
              "Lägg växeln i parkeringsläge (mitten, nere).",
              "Håll in kopplingen.",
              "Vrid om nyckeln." ] },
            { title: "Kör iväg", items: [
              "Håll ner bromsen.",
              "Lägg i ”framåt”.",
              "Släpp bromsen så att traktorn börjar rulla.",
              "Tryck på gasen." ] },
            { title: "Fyll tanken med vatten", items: [
              "Ta fram den gula, tjocka slangen.",
              "Koppla in den med böjen mot pumphuset och med brandkopplingen i tanken.",
              "Slå på vattnet.",
              "Vrid av kranen när tanken börjar bli full.",
              "Lossa kopplingen vid pumphuset.",
              "Vänta en kort stund så att slangen hinner tömmas på vatten vid tanken.",
              "Lossa slangen från tanken.",
              "Lägg undan slangen så att du kommer fram med traktorn nästa gång du ska fylla." ] },
            { title: "Spola", items: [
              "Börja i ett hörn av planen.",
              "Släpp på vattnet och spola.",
              "Vänd in på 1/3.",
              "Kör i cirka 7–8 km/h. Då räcker en full tank till en halv plan.",
              "Sluta vid mittlinjen. Det som blir kvar i tanken tömmer du på lilla planen, eller så fyller du på tanken igen.",
              "Fyll tanken och spola nästa lass på den andra planhalvan." ] },
            { title: "Låt frysa och upprepa", items: [
              "Vänta tills isen har frusit ordentligt.",
              "Upprepa steg 3–4.",
              "Fortsätt tills isen är 2–3 cm tjock och ytan är helt fri från grus (cirka 25–30 vändor)." ] },
          ],
        },
      ],
    },
  ];
  S.iceGuides = DEFAULT_ICE_GUIDES; S.guidesInDb = false;
  async function loadIceGuides() {
    const { data, error } = await sb.from("app_content").select("data").eq("key", "ice_guides").maybeSingle();
    if (error) { S.guidesInDb = false; return; }
    S.guidesInDb = true;
    if (data && Array.isArray(data.data)) S.iceGuides = data.data;
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function iceGuidesHtml(admin) {
    const G = S.iceGuides;
    const ctl = (attrs, label, icon, cls = "") => `<button class="btn sm ${cls}" ${attrs}>${icon ? svg(icon, 13) + " " : ""}${label}</button>`;
    let h = G.map((ch, ci) => `<div class="ig-chapter"><span>${esc(ch.chapter)}</span>
        ${admin ? `<span class="ig-ctl">${ctl(`data-chren="${ci}"`, "Byt namn")}${ctl(`data-chup="${ci}" ${ci === 0 ? "disabled" : ""}`, "↑")}${ctl(`data-chdown="${ci}" ${ci === G.length - 1 ? "disabled" : ""}`, "↓")}${!ch.sections.length ? ctl(`data-chdel="${ci}"`, "", "trash", "danger") : ""}</span>` : ""}</div>`
      + ch.sections.map((sec, si) => `
      <details class="g ig"${sec.open ? " open" : ""}><summary>${esc(sec.id || "")} ${esc(sec.title || "")}</summary>
        <div class="ig-body">
          ${sec.intro ? `<p class="ig-intro">${esc(sec.intro)}</p>` : ""}
          ${sec.goal ? `<div class="ig-box ig-goal"><b>Mål:</b> ${esc(sec.goal)}</div>` : ""}
          ${sec.warning ? `<div class="ig-box ig-warn"><b>⚠️ Viktigt:</b> ${esc(sec.warning)}</div>` : ""}
          ${(sec.steps || []).map((st, i) => `<div class="ig-step"><div class="ig-step-h"><span class="ig-num">${i + 1}</span>${esc(st.title)}</div>
            <ol>${st.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div>`).join("")}
          ${admin ? `<div class="ig-ctl ig-secctl">${ctl(`data-secedit="${ci}:${si}"`, "Redigera", "note", "primary")}
            ${ctl(`data-secup="${ci}:${si}" ${si === 0 ? "disabled" : ""}`, "↑ Upp")}${ctl(`data-secdown="${ci}:${si}" ${si === ch.sections.length - 1 ? "disabled" : ""}`, "↓ Ner")}
            ${ctl(`data-secdel="${ci}:${si}"`, "Ta bort", "trash", "danger")}</div>` : ""}
        </div></details>`).join("")).join("");
    if (admin) h += `<div class="ig-ctl" style="margin-top:10px">${ctl('id="igNewSec"', "+ Nytt avsnitt", "", "primary")}${ctl('id="igNewCh"', "+ Nytt kapitel")}</div>`;
    return h;
  }

  async function saveGuides(data) {
    if (!S.guidesInDb) {
      modal(`<h2>Redigera guider</h2><div class="alert">Redigering är inte installerad i databasen än.
        Kör filen <b>supabase-v4-guider.sql</b> i Supabase → SQL Editor → New query (se GUIDE.md).</div>`);
      return false;
    }
    try { await rpc("save_content", { p_key: "ice_guides", p_data: data, p_pin: S.pin, p_actor: actor() }); }
    catch { return false; }
    S.iceGuides = data; toast("Guiden sparad ✓"); return true;
  }

  function wireGuideAdmin(m) {
    const G = () => clone(S.iceGuides);
    const pos = (v) => v.split(":").map(Number);
    const after = async (data) => { if (await saveGuides(data)) openGuide(); };
    m.querySelectorAll("[data-secedit]").forEach((b) => b.onclick = () => { const [ci, si] = pos(b.dataset.secedit); openSectionEditor(ci, si); });
    m.querySelectorAll("[data-secup],[data-secdown]").forEach((b) => b.onclick = () => {
      const up = b.hasAttribute("data-secup"); const [ci, si] = pos(b.dataset.secup || b.dataset.secdown);
      const d = G(), arr = d[ci].sections, j = si + (up ? -1 : 1);
      [arr[si], arr[j]] = [arr[j], arr[si]]; after(d);
    });
    m.querySelectorAll("[data-secdel]").forEach((b) => b.onclick = () => {
      const [ci, si] = pos(b.dataset.secdel); const d = G(); const sec = d[ci].sections[si];
      if (!confirm(`Ta bort avsnittet "${sec.id || ""} ${sec.title || ""}"?`)) return;
      d[ci].sections.splice(si, 1); after(d);
    });
    m.querySelectorAll("[data-chren]").forEach((b) => b.onclick = () => {
      const ci = Number(b.dataset.chren); const d = G();
      const name = prompt("Kapitlets rubrik:", d[ci].chapter); if (!name || !name.trim()) return;
      d[ci].chapter = name.trim(); after(d);
    });
    m.querySelectorAll("[data-chup],[data-chdown]").forEach((b) => b.onclick = () => {
      const up = b.hasAttribute("data-chup"); const ci = Number(b.dataset.chup ?? b.dataset.chdown);
      const d = G(), j = ci + (up ? -1 : 1); [d[ci], d[j]] = [d[j], d[ci]]; after(d);
    });
    m.querySelectorAll("[data-chdel]").forEach((b) => b.onclick = () => {
      const ci = Number(b.dataset.chdel); const d = G();
      if (!confirm(`Ta bort det tomma kapitlet "${d[ci].chapter}"?`)) return;
      d.splice(ci, 1); after(d);
    });
    $("#igNewSec", m)?.addEventListener("click", () => openSectionEditor(null, null));
    $("#igNewCh", m)?.addEventListener("click", () => {
      const name = prompt("Rubrik för nytt kapitel (t.ex. \"2. Snöröjning\"):"); if (!name || !name.trim()) return;
      const d = G(); d.push({ chapter: name.trim(), sections: [] }); after(d);
    });
  }

  // Steg skrivs som text: en rad som börjar med # = nytt steg, övriga rader = moment
  const stepsToText = (steps) => (steps || []).map((st) => `# ${st.title}\n${st.items.join("\n")}`).join("\n\n");
  function textToSteps(txt) {
    const steps = [];
    for (const raw of txt.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) { steps.push({ title: line.replace(/^#+\s*/, ""), items: [] }); continue; }
      const item = line.replace(/^(\d+[.)]|[-•*])\s+/, "");
      if (!steps.length) steps.push({ title: "Steg", items: [] });
      steps[steps.length - 1].items.push(item);
    }
    return steps;
  }

  function openSectionEditor(ci, si) {
    const isNew = ci === null;
    const G = S.iceGuides;
    const sec = isNew ? { id: "", title: "", open: false, intro: "", goal: "", warning: "", steps: [] } : G[ci].sections[si];
    const m = modal(`<h2>${isNew ? "Nytt avsnitt" : "Redigera avsnitt"}</h2>
      <label for="seCh">Kapitel</label>
      <select id="seCh">${G.map((ch, i) => `<option value="${i}" ${i === (ci ?? G.length - 1) ? "selected" : ""}>${esc(ch.chapter)}</option>`).join("")}
        <option value="new">+ Nytt kapitel…</option></select>
      <div id="seNewChWrap" style="display:none"><label for="seNewCh">Nytt kapitels rubrik</label><input type="text" id="seNewCh" placeholder="T.ex. 2. Snöröjning"></div>
      <div class="grid2" style="grid-template-columns:90px 1fr">
        <div><label for="seId">Nummer</label><input type="text" id="seId" maxlength="10" value="${esc(sec.id || "")}" placeholder="1.2"></div>
        <div><label for="seTitle">Rubrik</label><input type="text" id="seTitle" maxlength="80" value="${esc(sec.title || "")}" placeholder="T.ex. Slangspolning"></div>
      </div>
      <label class="check"><input type="checkbox" id="seOpen" ${sec.open ? "checked" : ""}> Visa utfälld när guiden öppnas</label>
      <label for="seIntro">Inledning (valfritt)</label><textarea id="seIntro" maxlength="2000">${esc(sec.intro || "")}</textarea>
      <label for="seGoal">Mål (valfritt)</label><textarea id="seGoal" maxlength="1000">${esc(sec.goal || "")}</textarea>
      <label for="seWarn">⚠️ Viktigt (valfritt)</label><textarea id="seWarn" maxlength="1000">${esc(sec.warning || "")}</textarea>
      <label for="seSteps">Steg</label>
      <p class="gnote" style="margin:0 0 6px">Börja varje steg med en rad som börjar med <b>#</b>, t.ex. <code># Starta traktorn</code>.
        Skriv sedan ett moment per rad. Numreringen sköts automatiskt.</p>
      <textarea id="seSteps" class="ig-steps" placeholder="# Starta traktorn&#10;Slå på huvudströmbrytaren.&#10;Vrid om nyckeln.&#10;&#10;# Kör iväg&#10;Håll ner bromsen.">${esc(stepsToText(sec.steps))}</textarea>
      <div style="margin-top:14px"><button class="btn primary big" id="seSave">Spara</button></div>`, null, true);
    $("#seCh", m).onchange = () => { $("#seNewChWrap", m).style.display = $("#seCh", m).value === "new" ? "" : "none"; };
    $("#seSave", m).onclick = async () => {
      const title = $("#seTitle", m).value.trim();
      if (!title) return toast("Skriv en rubrik", true);
      const steps = textToSteps($("#seSteps", m).value);
      const upd = { id: $("#seId", m).value.trim(), title, open: $("#seOpen", m).checked,
        intro: $("#seIntro", m).value.trim(), goal: $("#seGoal", m).value.trim(), warning: $("#seWarn", m).value.trim(), steps };
      const d = clone(G);
      let target = $("#seCh", m).value;
      if (target === "new") {
        const name = $("#seNewCh", m).value.trim(); if (!name) return toast("Skriv det nya kapitlets rubrik", true);
        d.push({ chapter: name, sections: [] }); target = d.length - 1;
      } else target = Number(target);
      if (!isNew && target === ci) d[ci].sections[si] = upd;
      else { if (!isNew) d[ci].sections.splice(si, 1); d[target].sections.push(upd); }
      if (await saveGuides(d)) openGuide();
    };
  }
  // ---------- Guide ----------
  function detectDevice() {
    const ua = navigator.userAgent || "";
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const inApp = /FBAN|FBAV|FB_IAB|Messenger|Instagram/.test(ua);
    const chromeIOS = /CriOS/.test(ua);
    if (inApp) return "messenger";
    if (ios) return chromeIOS ? "ios-chrome" : "ios-safari";
    if (android) return "android";
    return "desktop";
  }
  async function openGuide() {
    await loadIceGuides();
    const dev = detectDevice();
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const o = (k) => (k === dev ? " open" : "");
    const ex = (st, label) => `<span class="st-${st}"><span class="pill">${label}</span></span>`;
    const gm = modal(`<h2>${svg("info", 20)} Guide</h2>
      <div class="meta">Isguider, hemskärmen och hur appen används.</div>

      <section><h4>Isguider</h4>${isAdmin() ? `<p class="gnote" style="margin:-4px 0 8px">Adminläge: du kan redigera, flytta och lägga till isguider.</p>` : ""}${iceGuidesHtml(isAdmin())}</section>

      <section><h4>Lägg appen på hemskärmen</h4>
        ${isStandalone ? `<div class="alert">Du har redan öppnat appen från hemskärmen. 👍</div>` : ""}
        <details class="g"${o("ios-safari")}><summary>iPhone – Safari</summary><ol>
          <li>Öppna <b>${esc(appUrl())}</b> i Safari.</li>
          <li>Tryck på <b>dela-knappen</b> ${svg("share", 15)} (längst ner eller uppe i adressfältet).</li>
          <li>Scrolla ner och välj <b>Lägg till på hemskärmen</b>.</li>
          <li>Tryck <b>Lägg till</b> uppe till höger.</li></ol></details>
        <details class="g"${o("ios-chrome")}><summary>iPhone – Chrome</summary><ol>
          <li>Tryck på <b>dela-ikonen</b> ${svg("share", 15)} till höger i adressfältet.</li>
          <li>Välj <b>Lägg till på hemskärmen</b> (scrolla ner om du inte ser det).</li>
          <li>Tryck <b>Lägg till</b>.</li></ol>
          <p class="gnote">Saknas valet? Öppna länken i Safari i stället och följ guiden ovan.</p></details>
        <details class="g"${o("android")}><summary>Android – Chrome</summary><ol>
          <li>Öppna länken i Chrome.</li>
          <li>Tryck på <b>⋮</b> uppe till höger.</li>
          <li>Välj <b>Lägg till på startskärmen</b> eller <b>Installera app</b>.</li>
          <li>Bekräfta med <b>Lägg till</b> / <b>Installera</b>.</li></ol></details>
        <details class="g"${o("messenger")}><summary>Öppnade du länken från Messenger?</summary>
          <p>Messengers inbyggda webbläsare kan inte lägga appen på hemskärmen. Tryck på <b>⋯</b> (uppe till höger) och välj
          <b>Öppna i Safari</b> eller <b>Öppna i Chrome</b>. Följ sedan guiden för din telefon.</p></details>
        <details class="g"${o("desktop")}><summary>Dator</summary>
          <p>Spara sidan som bokmärke, eller i Chrome/Edge: klicka på installera-ikonen i adressfältet för att få den som ett eget fönster.</p></details>
        <p class="gnote">På iPhone kommer hemskärmsappen inte ihåg valen från Safari – välj ditt namn en gång till första gången.</p>
      </section>

      <section><h4>Så läser du ett pass</h4>
        <div class="gdemo">
          <div class="c-top"><div class="c-time">18:00–20:00</div>${ex("red", "Saknar 1")}</div>
          <div class="c-mid"><b>Spolning</b><span class="place">· Båda</span><span class="spacer"></span><span class="wx">${wxIcon(26)}-6° snö</span></div>
          <div class="c-seats st-red"><span class="seat filled">Ma</span><span class="seat req"></span><span class="seat"></span><span class="c-names">Mattias</span></div>
        </div>
        <ul class="glist">
          <li><b>Tiden</b> står stort överst, därunder vad som ska göras och var (<i>Stora planen</i>, <i>Lilla planen</i> eller <i>Båda</i>).</li>
          <li><b>Cirklarna</b> är platserna på passet: <span class="seat filled sm">Ma</span> = bokad,
            <span class="st-red"><span class="seat req sm"></span></span> = måste fyllas, <span class="seat sm"></span> = får gärna vara fler.</li>
          <li><b>Märket</b> visar läget: ${ex("red", "Saknar 1")} ${ex("green", "Bemannat")} ${ex("full", "Fullt")} ${ex("jour", "Ingen jour")}</li>
          <li><b>Vädret</b> är prognosen under passet. Står det <span class="wx snow">${wxIcon(26)} snö</span> väntas snö – bra att veta för snöjouren.</li>
          <li><b>JOUR</b> = snöjour: den som bokar lovar att röja <i>om</i> det snöar.</li>
          <li>En <span class="noteic">${svg("note", 14)}</span> betyder att någon skrivit en anteckning. Dina egna pass har en blå ram.</li>
        </ul>
      </section>

      <section><h4>Boka och avboka</h4>
        <ul class="glist">
          <li><b>Första gången:</b> tryck på namnknappen uppe till höger och välj vem du är. Telefonen kommer ihåg det.
            Saknas ditt namn kan du lägga till det själv.</li>
          <li><b>Boka på mobilen:</b> tryck på passet → <b>Boka mig</b>.</li>
          <li><b>Boka på datorn:</b> välj <i>Vecka</i> och dra ditt namn från listan till vänster och släpp det på passet.</li>
          <li><b>Boka in någon annan:</b> öppna passet → välj namn i <i>Boka in någon annan</i>. Bra om någon sagt ja i Messenger.</li>
          <li><b>Avboka:</b> öppna passet → <b>Avboka mig</b> (eller <i>Avboka</i> bredvid ett namn). Avbokar du nära inpå får du en knapp
            för att be om ersättare i Messenger.</li>
          <li>Du kan inte vara bokad på två pass samtidigt. Pass som har passerat är låsta.</li>
        </ul>
      </section>

      <section><h4>Mer du kan göra</h4>
        <ul class="glist">
          <li><b>+ Nytt pass:</b> lägg upp ett eget pass, t.ex. spårning, hyvling eller snöröjning. Kryssa i <i>Snöjour</i> för ett jourpass.</li>
          <li><b>Anteckningar:</b> är du bokad på ett pass kan du skriva en anteckning, t.ex. "Tankvagnen läcker" eller "Klart 20:30".</li>
          <li><b>Lägg i kalender:</b> öppna passet → <i>Lägg i kalender</i> så får du en påminnelse en timme innan.</li>
          <li><b>Dela lediga pass:</b> gör en färdig text med alla pass som saknar folk – klistra in i Messenger-gruppen.</li>
          <li><b>Filter:</b> <i>Mina pass</i> visar bara dina, <i>Saknar folk</i> visar var det behövs folk.</li>
          <li><b>Logg:</b> visar vem som bokat, avbokat och ändrat vad.</li>
          <li><b>Tema:</b> knappen med måne/sol byter mellan ljust och mörkt.</li>
          <li><b>Admin – veckomallar:</b> knappen <i>Mallar</i> sparar en vecka som mall och lägger ut den på kommande veckor. Där kan du också rensa veckor.</li>
          <li><b>Admin – kopiera till annan dag:</b> i veckovyn finns ett streckat mallkort under varje dag. Dra ett pass dit så skapas en kopia den dagen, med samma tider.</li>
          <li><b>Admin – fyll på nedåt:</b> dra pilen ${svg("filldown", 14)} längst ner på ett pass nedåt för att skapa fler pass direkt efter, med samma längd. Du bekräftar längd och antal innan något skapas.</li>
          <li><b>Hänglåset</b> ${svg("lock", 14)} är för admin (kräver PIN-kod) och behövs inte för att boka.</li>
        </ul>
      </section>`);
    if (isAdmin()) wireGuideAdmin(gm);
  }

  // ---------- Logg ----------
  async function openLog() {
    const { data, error } = await sb.from("changelog").select("*").order("id", { ascending: false }).limit(150);
    if (error) return toast("Kunde inte hämta loggen", true);
    modal(`<h2>Ändringslogg</h2><div class="meta">De senaste ändringarna.</div>
      ${data.map((r) => { const d = new Date(r.at); return `<div class="log"><b>${esc(r.actor)}</b> ${esc(r.action.toLowerCase())}: ${esc(r.details)}<br><small>${shortDay(d)} ${hm(d)}</small></div>`; }).join("")}`);
  }

  // ---------- Start ----------
  $("#meBtn").onclick = () => openWho();
  $("#infoBtn").innerHTML = svg("info", 20);
  $("#infoBtn").onclick = openGuide;
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    store.set("isg_theme", dark ? "dark" : "light");
    const mc = document.querySelector('meta[name="theme-color"]'); if (mc) mc.content = dark ? "#0B141B" : "#0B2A3F";
    renderHeader();
  };
  $("#adminBtn").onclick = openAdmin;
  $("#newBtn").onclick = () => openShiftForm();
  window.matchMedia("(min-width: 900px)").addEventListener("change", () => { if (!S.view) render(); });

  const verEl = document.getElementById("ver"); if (verEl) verEl.textContent = "Version " + APP_VERSION;
  renderHeader();
  renderToolbar();
  load().then(() => { if (!me()) openWho(); loadWeather(); });
  setInterval(() => { if (!document.hidden) loadWeather(); }, 10 * 60000);
})();
