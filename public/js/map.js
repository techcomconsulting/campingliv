// Karta med campingar och ställplatser från OpenStreetMap.
// Kartbilder: OpenStreetMap. Platser: Overpass API. Sök: Nominatim.
const LEAFLET = "/vendor/leaflet/leaflet-src.esm.js";
const LEAFLET_CDN = "https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js";
const DATA = "/data/campings.json";
const NORDEN = { s: 54, w: 4, n: 71.5, e: 32 }; // här finns färdig data
const MAX_PINS = 600;
const OVERPASS = "https://overpass-api.de/api/interpreter";
const MIN_ZOOM = 9;      // för livehämtning utanför Norden
const MIN_ZOOM_LOCAL = 7;

let L = null;
let places = null; // färdig data, laddas en gång
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

// Laddar kartprogrammet (används även av resor)
export async function loadLeaflet() {
  L = L || await import(LEAFLET).catch(() => import(LEAFLET_CDN));
  return L;
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

  try { L = L || await import(LEAFLET).catch(() => import(LEAFLET_CDN)); }
  catch { status("Kartan kunde inte laddas. Kolla internet."); return; }
  if (!places) {
    places = fetch(DATA).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([lastView.lat, lastView.lng], lastView.zoom);
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

  const localLayer = L.layerGroup().addTo(map);
  const dotLayer = L.layerGroup().addTo(map);
  const pinCache = new Map();
  const dotCache = new Map();
  const tagsOf = (data, i) => {
    const [, , t, name, bits, phone, web, addr] = data.places[i];
    const tags = { name, phone, website: web };
    if (addr) tags["addr:street"] = addr;
    data.fac.forEach((k, b) => { if (bits & (1 << b)) tags[k] = "yes"; });
    return [tags, t ? "caravan_site" : "camp_site"];
  };

  // Utzoomat: små prickar (ritas snabbt, även tusentals)
  function showDots(data) {
    localLayer.clearLayers();
    if (dotLayer.getLayers().length) return status("");
    data.places.forEach((p, i) => {
      const m = L.circleMarker([p[0], p[1]], { radius: 4, weight: 1, color: "#fff",
        fillColor: p[2] ? "#c9832e" : "#2f5d46", fillOpacity: 0.9 })
        .bindPopup(() => { const [tags, type] = tagsOf(data, i); return popupHtml(tags, type); }, { maxWidth: 260 });
      dotCache.set(i, m); m.addTo(dotLayer);
    });
    status("");
  }

  // Visar platser från den färdiga listan – går direkt
  function showLocal(data) {
    const v = map.getBounds().pad(0.1);
    const s = v.getSouth(), w = v.getWest(), n = v.getNorth(), e = v.getEast();
    const inView = [];
    for (let i = 0; i < data.places.length; i++) {
      const p = data.places[i];
      if (p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e) inView.push(i);
      if (inView.length > MAX_PINS) break;
    }
    localLayer.clearLayers();
    dotLayer.clearLayers();
    if (inView.length > MAX_PINS) return showDots(data);
    for (const i of inView) {
      let m = pinCache.get(i);
      if (!m) {
        const [tags, type] = tagsOf(data, i);
        m = L.marker([data.places[i][0], data.places[i][1]], { icon: icon(type), title: tags.name })
          .bindPopup(() => popupHtml(tags, type), { maxWidth: 260 });
        pinCache.set(i, m);
      }
      m.addTo(localLayer);
    }
    status(inView.length ? "" : "Inga campingar här");
  }

  const inNorden = () => {
    const c = map.getCenter();
    return c.lat > NORDEN.s && c.lat < NORDEN.n && c.lng > NORDEN.w && c.lng < NORDEN.e;
  };

  async function load() {
    const c = map.getCenter();
    lastView = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
    const data = await places;
    if (data && inNorden()) {
      layer.clearLayers();
      return map.getZoom() < MIN_ZOOM_LOCAL ? showDots(data) : showLocal(data);
    }
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

  map.on("moveend", () => { clearTimeout(timer); timer = setTimeout(load, 150); });
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
