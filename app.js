/* IS-gruppen – passbokning */
(() => {
  "use strict";
  const APP_VERSION = "1.5 (ny design)";

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
    a.textContent = isAdmin() ? "Admin ✓" : "Admin";
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
    </div>`;
  }

  const SHIFT_MIME = "application/x-isg-shift";
  function wireCards(root) {
    const canDragShifts = isWeekView() && isAdmin();
    root.querySelectorAll(".card").forEach((c) => {
      const id = Number(c.dataset.id);
      c.onclick = () => openShift(id);
      if (canDragShifts) {
        c.draggable = true;
        c.title = "Dra till ett annat pass för att kopiera passets inställningar dit";
        c.addEventListener("dragstart", (e) => { e.dataTransfer.setData(SHIFT_MIME, String(id)); e.dataTransfer.effectAllowed = "copy"; c.classList.add("dragging"); });
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

  function renderWeek() {
    const main = $("#main");
    const todayKey = dayKey(new Date());
    const chips = S.people.filter((p) => p.active)
      .map((p) => `<span class="chip${p.id === S.meId ? " me" : ""}" draggable="true" data-pid="${p.id}">${esc(p.name)}</span>`).join("");
    let cols = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(S.weekStart, i), k = dayKey(d);
      const items = S.shifts.filter((s) => dayKey(s.start) === k);
      cols += `<div class="wcol"><div class="whead${k === todayKey ? " today" : ""}">${shortDay(d)}${wxDay(d)}</div>${items.map((s) => cardHtml(s, true)).join("") || ""}</div>`;
    }
    main.innerHTML = `<div class="weekwrap">
      <aside class="names"><h3>Namn</h3>${chips}<button class="chip add" id="addNameChip">+ Namn</button>
      <p class="hint">Dra ett namn till ett pass för att boka.${isAdmin() ? "<br><br>Admin: dra ett pass till ett annat pass för att kopiera inställningarna dit (datumet behålls)." : ""}</p></aside>
      <div class="week">${cols}</div></div>`;
    main.querySelectorAll(".chip[data-pid]").forEach((c) => {
      c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", c.dataset.pid); e.dataTransfer.effectAllowed = "copy"; });
    });
    $("#addNameChip").onclick = () => openWho(true);
    wireCards(main);
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
        <button class="btn big" id="adminOff">Lämna adminläge</button>`);
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
      <label>Typ av arbete</label><select id="fType">${Object.keys(WORK_TYPES).map((t) => `<option ${s?.work_type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
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
      const [mn, mx] = WORK_TYPES[$("#fType", m).value] || [1, 2];
      $("#fMin", m).value = mn; $("#fMax", m).value = mx;
    };
    if (isNew) applyDefaults();
    $("#fType", m).onchange = applyDefaults;
    $("#fJour", m).onchange = (e) => {
      if (e.target.checked && isNew) { $("#fType", m).value = "Snöröjning"; applyDefaults(); if (!$("#fTitle", m).value) $("#fTitle", m).value = "Snöjour"; }
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

  // ---------- Logg ----------
  async function openLog() {
    const { data, error } = await sb.from("changelog").select("*").order("id", { ascending: false }).limit(150);
    if (error) return toast("Kunde inte hämta loggen", true);
    modal(`<h2>Ändringslogg</h2><div class="meta">De senaste ändringarna.</div>
      ${data.map((r) => { const d = new Date(r.at); return `<div class="log"><b>${esc(r.actor)}</b> ${esc(r.action.toLowerCase())}: ${esc(r.details)}<br><small>${shortDay(d)} ${hm(d)}</small></div>`; }).join("")}`);
  }

  // ---------- Start ----------
  $("#meBtn").onclick = () => openWho();
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
