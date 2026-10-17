// Resor: skapa, lägga till stopp, se på karta och dela i flödet.
import { db, F } from "./firebase.js";
import { loadLeaflet } from "./map.js";

const {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where,
  getDocs, serverTimestamp, limit,
} = F;

export const VEHICLES = ["Husbil", "Husvagn", "Campervan", "Tält", "Bil", "Motorcykel", "Cykel", "Båt", "Annat"];
const MAX_STOPS = 100;

// ---------- Avstånd ----------
function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
export const tripKm = (stops) => Math.round(stops.slice(1).reduce((s, p, i) => s + haversine(stops[i], p), 0));
export const milText = (km) => (km >= 10 ? `${Math.round(km / 10)} mil` : `${km} km`);

export function tripDays(t) {
  if (!t.startDate) return 0;
  const end = t.endDate || new Date().toISOString().slice(0, 10);
  return Math.max(1, Math.round((new Date(end) - new Date(t.startDate)) / 864e5) + 1);
}

// ---------- Ruttbild (SVG) för flödet ----------
// route = [lat, lon, lat, lon, ...]
export function routeSvg(route, esc) {
  const pts = [];
  for (let i = 0; i + 1 < route.length; i += 2) pts.push([route[i], route[i + 1]]);
  if (!pts.length) return "";
  const midLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const k = Math.cos(midLat * Math.PI / 180);
  const xy = pts.map(([la, lo]) => [lo * k, -la]);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const W = 300, H = 300, pad = 40;
  const w = Math.max(...xs) - Math.min(...xs) || 0.01, h = Math.max(...ys) - Math.min(...ys) || 0.01;
  const sc = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
  const ox = (W - w * sc) / 2 - Math.min(...xs) * sc, oy = (H - h * sc) / 2 - Math.min(...ys) * sc;
  const P = xy.map(([x, y]) => [+(x * sc + ox).toFixed(1), +(y * sc + oy).toFixed(1)]);
  const line = P.map((p) => p.join(",")).join(" ");
  const dots = P.map(([x, y], i) => {
    const end = i === 0 || i === P.length - 1;
    return `<circle cx="${x}" cy="${y}" r="${end ? 7 : 4.5}" fill="${end ? "#fff" : "#f3d27a"}" stroke="#1d3a2c" stroke-width="2"/>`;
  }).join("");
  const [fx, fy] = P[P.length - 1];
  return `<svg class="route-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polyline points="${line}" fill="none" stroke="rgb(0 0 0 / .25)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line}" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 10"/>
    ${dots}
    <text x="${fx}" y="${fy - 12}" font-size="22" text-anchor="middle">🏁</text>
  </svg>`;
}

// Förenklar rutten till max n punkter (för inlägg)
export function packRoute(stops, n = 60) {
  const step = Math.max(1, Math.ceil(stops.length / n));
  const pick = stops.filter((_, i) => i % step === 0 || i === stops.length - 1);
  return pick.flatMap((s) => [+s.lat.toFixed(4), +s.lon.toFixed(4)]);
}

// ---------- Sidor ----------
export function setupTrips(ctx) {
  const { $main, esc, toast, errText, busy, VIS, me, profile, canSee } = ctx;

  async function myTrips() {
    const snap = await getDocs(query(collection(db, "trips"), where("ownerId", "==", me().uid), limit(100)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  }

  function statusOf(t) {
    const today = new Date().toISOString().slice(0, 10);
    if (t.endDate && t.endDate < today) return { label: "Avslutad", cls: "done" };
    if (t.startDate && t.startDate > today) return { label: "Planerad", cls: "plan" };
    return { label: "Pågår", cls: "live" };
  }

  function tripTile(t) {
    const st = statusOf(t);
    const km = tripKm(t.stops || []);
    return `<a class="trip-tile" href="#/resa/${esc(t.id)}">
      <div class="trip-art">${routeSvg(packRoute(t.stops || []), esc) || "<span>🚐</span>"}</div>
      <div class="trip-info"><span class="badge ${st.cls}">${st.label}</span>
        <b>${esc(t.name)}</b>
        <small>${t.startDate ? esc(t.startDate) : "Inget datum"} · ${(t.stops || []).length} stopp${km ? ` · ${milText(km)}` : ""}</small>
      </div></a>`;
  }

  async function renderTrips() {
    $main.innerHTML = `<div class="loading">Laddar resor…</div>`;
    try {
      const list = await myTrips();
      $main.innerHTML = `
        <h1 class="page">Mina resor</h1>
        <button class="btn primary wide" id="newTrip">＋ Ny resa</button>
        <div class="trip-list">${list.length ? list.map(tripTile).join("")
          : `<div class="card empty"><p>🚐 Du har inga resor än.</p><p class="muted">Skapa en resa och lägg till stopp längs vägen.</p></div>`}</div>`;
      document.getElementById("newTrip").onclick = () => renderTripForm();
    } catch (e) { $main.innerHTML = `<div class="card notice">${esc(errText(e))}</div>`; }
  }

  function renderTripForm(t = null) {
    const v = t || { name: "", description: "", vehicle: "Husbil", visibility: "friends",
      startDate: new Date().toISOString().slice(0, 10), endDate: "", travelers: 2 };
    $main.innerHTML = `
      <h1 class="page">${t ? "Ändra resa" : "Ny resa"}</h1>
      <form class="card" id="tripForm">
        <label>Namn<input name="name" required maxlength="100" value="${esc(v.name)}" placeholder="T.ex. Sommarresan 2027 – Sverige till Kroatien"></label>
        <label>Beskrivning<textarea name="description" rows="3" maxlength="2000">${esc(v.description)}</textarea></label>
        <div class="two">
          <label>Start<input type="date" name="startDate" value="${esc(v.startDate)}"></label>
          <label>Slut<input type="date" name="endDate" value="${esc(v.endDate)}"></label>
        </div>
        <div class="two">
          <label>Fordon<select name="vehicle">${VEHICLES.map((x) => `<option ${x === v.vehicle ? "selected" : ""}>${x}</option>`).join("")}</select></label>
          <label>Antal resenärer<input type="number" name="travelers" min="1" max="20" value="${esc(v.travelers || 1)}"></label>
        </div>
        <label>Vem får se resan?
          <select name="visibility">${Object.entries(VIS).map(([k, x]) =>
            `<option value="${k}" ${k === v.visibility ? "selected" : ""}>${x.icon} ${x.label}</option>`).join("")}</select></label>
        <button class="btn primary" type="submit">${t ? "Spara" : "Skapa resa"}</button>
        ${t ? `<button class="btn wide danger" type="button" id="delTrip">Ta bort resan</button>` : ""}
      </form>`;
    const f = document.getElementById("tripForm");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector("[type=submit]"); busy(btn, true);
      const d = Object.fromEntries(new FormData(f));
      if (d.endDate && d.startDate && d.endDate < d.startDate) { toast("Slutdatum är före start.", true); return busy(btn, false); }
      const data = { name: d.name.trim(), description: d.description.trim(), startDate: d.startDate,
        endDate: d.endDate, vehicle: d.vehicle, travelers: Math.max(1, Math.min(20, +d.travelers || 1)),
        visibility: d.visibility, updatedAt: serverTimestamp() };
      try {
        if (t) { await updateDoc(doc(db, "trips", t.id), data); location.hash = `#/resa/${t.id}`; }
        else {
          const ref = await addDoc(collection(db, "trips"), { ...data, ownerId: me().uid,
            ownerName: profile().displayName, stops: [], createdAt: serverTimestamp() });
          toast("Resan är skapad! Lägg till ditt första stopp.");
          location.hash = `#/resa/${ref.id}`;
        }
      } catch (e) { toast(errText(e), true); busy(btn, false); }
    };
    const del = document.getElementById("delTrip");
    if (del) del.onclick = async () => {
      if (!confirm("Ta bort resan? Inläggen ligger kvar i flödet.")) return;
      try { await deleteDoc(doc(db, "trips", t.id)); toast("Resan är borttagen."); location.hash = "#/resor"; }
      catch (e) { toast(errText(e), true); }
    };
  }

  async function renderTrip(id) {
    $main.innerHTML = `<div class="loading">Laddar resan…</div>`;
    let t;
    try {
      const snap = await getDoc(doc(db, "trips", id));
      if (!snap.exists()) { $main.innerHTML = `<div class="card empty"><p>Resan finns inte längre.</p></div>`; return; }
      t = { id, ...snap.data() };
    } catch (e) {
      $main.innerHTML = `<div class="card notice">${e?.code === "permission-denied" ? "Du får inte se den här resan." : esc(errText(e))}</div>`;
      return;
    }
    const mine = t.ownerId === me().uid;
    const stops = t.stops || [];
    const km = tripKm(stops), days = tripDays(t), st = statusOf(t), v = VIS[t.visibility] || VIS.public;

    $main.innerHTML = `
      <a class="back" href="#/resor">‹ Resor</a>
      <div class="trip-head">
        <span class="badge ${st.cls}">${st.label}</span>
        <h1>${esc(t.name)}</h1>
        <small>av ${esc(t.ownerName)} · ${v.icon} ${v.label}</small>
        ${t.description ? `<p>${esc(t.description)}</p>` : ""}
      </div>
      <div class="stats">
        <div><b>${days || "–"}</b><small>dagar</small></div>
        <div><b>${km ? milText(km) : "–"}</b><small>fågelväg</small></div>
        <div><b>${stops.length}</b><small>stopp</small></div>
        <div><b>${esc(t.vehicle || "–")}</b><small>fordon</small></div>
      </div>
      <div id="tripMap" class="trip-map"></div>
      ${mine ? `<div class="row actions-row">
        <button class="btn primary" id="shareTrip">📣 Dela i flödet</button>
        <button class="btn" id="linkTrip" aria-label="Skicka länk">🔗</button>
        <button class="btn" id="editTrip" aria-label="Ändra">✏️</button></div>`
      : `<div class="row actions-row"><button class="btn" id="linkTrip">🔗 Skicka länk</button></div>`}
      <h2>Stopp</h2>
      ${mine ? `<form class="card add-stop" id="stopForm">
        <div class="row"><input name="q" placeholder="Sök plats, t.ex. Hjo Camping" autocomplete="off" required>
        <button class="btn primary">Lägg till</button></div>
        <button type="button" class="link" id="hereStop">📍 Lägg till där jag är nu</button>
        <div id="stopHits"></div>
      </form>` : ""}
      <ol class="stops">${stops.map((s, i) => `<li>
        <span class="n">${i === 0 ? "🚩" : i === stops.length - 1 ? "🏁" : i + 1}</span>
        <div><b>${esc(s.name)}</b>${s.date ? `<small>${esc(s.date)}</small>` : ""}</div>
        ${mine ? `<span class="tools"><button class="icon" data-up="${i}" ${i ? "" : "disabled"} aria-label="Flytta upp">↑</button>
          <button class="icon" data-rm="${i}" aria-label="Ta bort">✕</button></span>` : ""}</li>`).join("")
        || `<p class="muted">Inga stopp än.${mine ? " Sök efter en plats ovan." : ""}</p>`}</ol>
      <h2>Inlägg från resan</h2>
      <div id="tripPosts"><div class="loading">Laddar…</div></div>`;

    // Karta med rutt
    loadLeaflet().then((L) => {
      const el = document.getElementById("tripMap");
      if (!el) return;
      const map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false })
        .setView([62, 15], 4);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
      if (stops.length) {
        const ll = stops.map((s) => [s.lat, s.lon]);
        L.polyline(ll, { color: "#2f5d46", weight: 4, dashArray: "2 8", lineCap: "round" }).addTo(map);
        stops.forEach((s, i) => L.circleMarker([s.lat, s.lon], { radius: i === 0 || i === stops.length - 1 ? 8 : 6,
          color: "#fff", weight: 2, fillColor: i === stops.length - 1 ? "#b4562e" : "#2f5d46", fillOpacity: 1 })
          .bindTooltip(`${i + 1}. ${esc(s.name)}`).addTo(map));
        map.fitBounds(L.latLngBounds(ll).pad(0.2), { maxZoom: 12 });
      }
    }).catch(() => {});

    // Länk
    document.getElementById("linkTrip").onclick = async () => {
      const url = `${location.origin}/#/resa/${t.id}`;
      try {
        if (navigator.share) await navigator.share({ title: t.name, text: `Följ resan "${t.name}" på Campingliv`, url });
        else { await navigator.clipboard.writeText(url); toast("Länken är kopierad!"); }
      } catch { /* avbrutet */ }
    };

    if (mine) {
      document.getElementById("editTrip").onclick = () => renderTripForm(t);
      document.getElementById("shareTrip").onclick = () => shareDialog(t);

      const save = async (next) => {
        try { await updateDoc(doc(db, "trips", t.id), { stops: next, updatedAt: serverTimestamp() }); renderTrip(t.id); }
        catch (e) { toast(errText(e), true); }
      };
      const addStop = (s) => {
        if (stops.length >= MAX_STOPS) return toast(`Max ${MAX_STOPS} stopp per resa.`, true);
        save([...stops, { name: s.name.slice(0, 120), lat: +(+s.lat).toFixed(5), lon: +(+s.lon).toFixed(5),
          date: new Date().toISOString().slice(0, 10) }]);
      };
      $main.querySelectorAll("[data-rm]").forEach((b) => b.onclick = () => {
        if (confirm(`Ta bort ${stops[+b.dataset.rm].name}?`)) save(stops.filter((_, i) => i !== +b.dataset.rm));
      });
      $main.querySelectorAll("[data-up]").forEach((b) => b.onclick = () => {
        const i = +b.dataset.up, n = [...stops];
        [n[i - 1], n[i]] = [n[i], n[i - 1]]; save(n);
      });

      const f = document.getElementById("stopForm");
      const hits = document.getElementById("stopHits");
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        hits.innerHTML = `<small>Söker…</small>`;
        try {
          const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=sv&q="
            + encodeURIComponent(f.q.value.trim()));
          const list = await r.json();
          hits.innerHTML = list.length ? list.map((h, i) => `<button type="button" class="hit" data-hit="${i}">
            <b>${esc(h.name || h.display_name.split(",")[0])}</b><small>${esc(h.display_name)}</small></button>`).join("")
            : `<small>Hittade inget.</small>`;
          hits.querySelectorAll("[data-hit]").forEach((b) => b.onclick = () => {
            const h = list[+b.dataset.hit];
            addStop({ name: h.name || h.display_name.split(",")[0], lat: h.lat, lon: h.lon });
          });
        } catch { hits.innerHTML = `<small>Sökningen fungerar inte just nu.</small>`; }
      };
      document.getElementById("hereStop").onclick = () => {
        if (!navigator.geolocation) return toast("Din enhet kan inte visa position.", true);
        toast("Hämtar din position…");
        navigator.geolocation.getCurrentPosition(async (p) => {
          const { latitude: lat, longitude: lon } = p.coords;
          let name = "Min plats";
          try {
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&accept-language=sv&lat=${lat}&lon=${lon}`);
            const j = await r.json();
            const a = j.address || {};
            name = j.name || a.village || a.town || a.city || a.municipality || name;
          } catch { /* behåll namnet */ }
          addStop({ name, lat, lon });
        }, () => toast("Du har inte gett appen lov att se din position.", true), { timeout: 10000 });
      };
    }

    // Inlägg kopplade till resan
    try {
      const vis = mine ? ["public", "friends", "private"] : (await canSee(t.ownerId)) ? ["public", "friends"] : ["public"];
      const snap = await getDocs(query(collection(db, "posts"), where("authorId", "==", t.ownerId),
        where("trip.id", "==", t.id), where("visibility", "in", vis), limit(50)));
      const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      const box = document.getElementById("tripPosts");
      box.innerHTML = posts.length ? posts.map(ctx.postCard).join("")
        : `<p class="muted">Inga inlägg ännu.${mine ? " Välj resan när du skriver ett inlägg." : ""}</p>`;
      box.querySelectorAll(".ig").forEach((el) => ctx.wirePost(el, posts.find((p) => p.id === el.dataset.id)));
    } catch (e) {
      document.getElementById("tripPosts").innerHTML = `<small>${esc(errText(e))}</small>`;
    }
  }

  function shareDialog(t) {
    const stops = t.stops || [];
    if (stops.length < 1) return toast("Lägg till minst ett stopp först.", true);
    const km = tripKm(stops);
    const dlg = document.createElement("div");
    dlg.className = "sheet-bg";
    dlg.innerHTML = `<form class="sheet">
      <h2>Dela resan i flödet</h2>
      <div class="share-prev">${routeSvg(packRoute(stops), esc)}<b>${esc(t.name)}</b>
        <small>${stops.length} stopp${km ? ` · ${milText(km)}` : ""}</small></div>
      <label>Skriv något<textarea name="text" rows="3" maxlength="5000" required>${esc(
        stops.length > 1 ? `Från ${stops[0].name} till ${stops[stops.length - 1].name}! 🚐` : `Nu börjar resan! 🚐`)}</textarea></label>
      <label>Vem får se?<select name="visibility">${Object.entries(VIS).map(([k, x]) =>
        `<option value="${k}" ${k === t.visibility ? "selected" : ""}>${x.icon} ${x.label}</option>`).join("")}</select></label>
      <button class="btn primary wide">Dela</button>
      <button class="btn wide" type="button" data-close>Avbryt</button></form>`;
    document.body.appendChild(dlg);
    dlg.onclick = (e) => { if (e.target === dlg || e.target.dataset.close !== undefined) dlg.remove(); };
    const f = dlg.querySelector("form");
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector(".primary"); busy(btn, true);
      try {
        await addDoc(collection(db, "posts"), {
          authorId: me().uid, authorName: profile().displayName,
          title: t.name.slice(0, 150), place: "", text: f.text.value.trim(), visibility: f.visibility.value,
          trip: { id: t.id, name: t.name.slice(0, 100), km, stops: stops.length, days: tripDays(t), route: packRoute(stops) },
          createdAt: serverTimestamp(),
        });
        dlg.remove(); toast("Resan är delad i flödet!"); location.hash = "#/flode";
      } catch (e) { toast(errText(e), true); busy(btn, false); }
    };
  }

  return { renderTrips, renderTrip, myTrips, statusOf };
}
