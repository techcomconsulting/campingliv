// Karta med campingar och ställplatser från OpenStreetMap.
// Kartbilder: OpenStreetMap. Platser: Overpass API. Sök: Nominatim.
const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const MIN_ZOOM = 9;

let L = null;
let lastView = { lat: 59.3, lng: 15.5, zoom: 6 }; // Sverige

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TYPES = {
  camp_site: { label: "Camping", icon: "⛺" },
  caravan_site: { label: "Ställplats", icon: "🚐" },
};

const FACILITIES = [
  ["toilets", "🚻 Toalett"], ["shower", "🚿 Dusch"], ["power_supply", "🔌 El"],
  ["internet_access", "📶 Wifi"], ["drinking_water", "💧 Vatten"],
  ["sanitary_dump_station", "🚽 Tömning"], ["dog", "🐕 Hund"], ["swimming_pool", "🏊 Pool"],
];

function hasTag(t, key) {
  const v = t[key];
  return v && v !== "no" && v !== "none";
}

function popupHtml(t, type) {
  const name = t.name || (type === "caravan_site" ? "Ställplats utan namn" : "Camping utan namn");
  const fac = FACILITIES.filter(([k]) => hasTag(t, k)).map(([, l]) => `<span>${l}</span>`).join("");
  const web = t.website || t["contact:website"];
  const phone = t.phone || t["contact:phone"];
  const addr = [t["addr:street"] && `${t["addr:street"]} ${t["addr:housenumber"] || ""}`.trim(),
    t["addr:city"]].filter(Boolean).join(", ");
  return `
    <div class="pop">
      <small>${TYPES[type].icon} ${TYPES[type].label}</small>
      <b>${esc(name)}</b>
      ${addr ? `<div>${esc(addr)}</div>` : ""}
      ${fac ? `<div class="fac">${fac}</div>` : ""}
      ${phone ? `<div>📞 <a href="tel:${esc(phone)}">${esc(phone)}</a></div>` : ""}
      ${web && /^https?:\/\//.test(web) ? `<div>🌐 <a href="${esc(web)}" target="_blank" rel="noopener">Webbplats</a></div>` : ""}
      <button class="btn primary" data-post="${esc(name)}">Skriv inlägg här</button>
    </div>`;
}

export async function renderMap($main, onPost) {
  $main.innerHTML = `
    <div class="map-wrap">
      <form class="map-search" id="mapSearch">
        <input name="q" placeholder="Sök ort, t.ex. Hjo" autocomplete="off">
        <button class="btn primary" aria-label="Sök">🔍</button>
      </form>
      <div id="map"></div>
      <button class="map-me" id="mapMe" aria-label="Min position">📍</button>
      <div class="map-status" id="mapStatus">Laddar kartan…</div>
    </div>`;
  const $status = document.getElementById("mapStatus");
  const status = (txt) => { $status.textContent = txt; $status.hidden = !txt; };

  try { L = L || await import(LEAFLET); }
  catch { status("Kartan kunde inte laddas. Kolla internet."); return; }

  const map = L.map("map", { zoomControl: false }).setView([lastView.lat, lastView.lng], lastView.zoom);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  const seen = new Set();
  const loaded = []; // rutor vi redan hämtat
  let timer = null, ctrl = null;

  const icon = (type) => L.divIcon({
    className: "pin " + type, html: TYPES[type].icon, iconSize: [34, 34], iconAnchor: [17, 17],
  });

  async function load() {
    const c = map.getCenter();
    lastView = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    if (map.getZoom() < MIN_ZOOM) { status("Zooma in för att se campingar och ställplatser"); return; }
    const b = map.getBounds().pad(0.2);
    if (loaded.some((x) => x.contains(map.getBounds()))) { status(""); return; }
    ctrl?.abort(); ctrl = new AbortController();
    status("Hämtar platser…");
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(4)).join(",");
    const q = `[out:json][timeout:25];nwr["tourism"~"^(camp_site|caravan_site)$"](${bbox});out center tags 500;`;
    try {
      const r = await fetch(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctrl.signal });
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      loaded.push(b);
      let n = 0;
      for (const el of data.elements) {
        const key = el.type + el.id;
        if (seen.has(key)) continue;
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        const type = el.tags?.tourism;
        if (lat == null || !TYPES[type]) continue;
        seen.add(key); n++;
        L.marker([lat, lon], { icon: icon(type), title: el.tags.name || "" })
          .bindPopup(() => popupHtml(el.tags, type), { maxWidth: 260 })
          .addTo(layer);
      }
      status(seen.size ? "" : "Inga campingar hittades här");
    } catch (e) {
      if (e.name !== "AbortError") status("Kunde inte hämta platser just nu. Försök igen strax.");
    }
  }

  map.on("moveend", () => { clearTimeout(timer); timer = setTimeout(load, 500); });
  map.on("popupopen", (e) => {
    const btn = e.popup.getElement().querySelector("[data-post]");
    if (btn) btn.onclick = () => onPost(btn.dataset.post);
  });
  load();

  document.getElementById("mapMe").onclick = () => {
    if (!navigator.geolocation) return status("Din enhet kan inte visa position.");
    status("Hämtar din position…");
    navigator.geolocation.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 12),
      () => status("Du har inte gett appen lov att se din position."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  document.getElementById("mapSearch").onsubmit = async (ev) => {
    ev.preventDefault();
    const q = ev.target.q.value.trim();
    if (!q) return;
    status("Söker…");
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=sv&q="
        + encodeURIComponent(q));
      const [hit] = await r.json();
      if (!hit) return status("Hittade inte platsen.");
      map.setView([+hit.lat, +hit.lon], 11);
      ev.target.q.blur();
    } catch { status("Sökningen fungerar inte just nu."); }
  };
}
