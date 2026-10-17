import { auth, db, A, F } from "./firebase.js";
import { renderMap } from "./map.js";

const {
  doc, getDoc, setDoc, addDoc, deleteDoc, collection, query, where,
  orderBy, limit, getDocs, serverTimestamp, writeBatch, getCountFromServer,
} = F;

const $main = document.getElementById("main");
const $nav = document.getElementById("nav");

let me = null;        // Firebase-användaren
let profile = null;   // användarens profil i databasen
let prefillPlace = ""; // plats vald på kartan

// ---------- Hjälpfunktioner ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const VIS = {
  public: { icon: "🌍", label: "Offentligt" },
  friends: { icon: "👥", label: "Endast vänner" },
  private: { icon: "🔒", label: "Privat" },
};

function timeAgo(ts) {
  if (!ts?.toDate) return "nyss";
  const s = (Date.now() - ts.toDate().getTime()) / 1000;
  if (s < 60) return "nyss";
  if (s < 3600) return `${Math.floor(s / 60)} min sedan`;
  if (s < 86400) return `${Math.floor(s / 3600)} tim sedan`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d sedan`;
  return ts.toDate().toLocaleDateString("sv-SE");
}

function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function errText(e) {
  const c = e?.code || "";
  const map = {
    "auth/invalid-credential": "Fel e-post eller lösenord.",
    "auth/email-already-in-use": "E-postadressen används redan.",
    "auth/weak-password": "Lösenordet måste ha minst 8 tecken.",
    "auth/invalid-email": "E-postadressen ser inte rätt ut.",
    "auth/too-many-requests": "För många försök. Vänta en stund.",
    "auth/network-request-failed": "Ingen internetanslutning.",
    "auth/operation-not-allowed": "Inloggning med e-post är inte aktiverad i Firebase ännu.",
    "permission-denied": "Du har inte behörighet till detta.",
    "unavailable": "Databasen kan inte nås just nu.",
  };
  return map[c] || e?.message || "Något gick fel.";
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.dataset.txt ??= btn.textContent;
  btn.textContent = on ? "Vänta…" : btn.dataset.txt;
}

// Visar en knapp om databasen behöver ett index (en gång per index).
function indexHelp(e) {
  const m = String(e?.message || "").match(/https:\/\/console\.firebase\.google\.com\S+/);
  if (!m) return "";
  return `<div class="card notice">Databasen behöver förberedas för flödet.
    <a class="btn" target="_blank" rel="noopener" href="${esc(m[0])}">Skapa index i Firebase</a>
    <small>Klicka, tryck "Spara", vänta ett par minuter och ladda om.</small></div>`;
}

// ---------- Inloggning ----------
function renderAuth(mode = "login") {
  $nav.hidden = true;
  const isNew = mode === "register";
  $main.innerHTML = `
  <section class="auth">
    <div class="brand"><span class="logo">⛺</span><h1>Campingliv</h1>
      <p>Dela dina resor, campingar och äventyr.</p></div>
    <form class="card" id="authForm">
      <h2>${isNew ? "Skapa konto" : "Logga in"}</h2>
      ${isNew ? `<label>Namn<input name="name" required minlength="2" maxlength="50" autocomplete="name"></label>` : ""}
      <label>E-post<input name="email" type="email" required autocomplete="email"></label>
      <label>Lösenord<input name="pw" type="password" required minlength="${isNew ? 8 : 1}"
        autocomplete="${isNew ? "new-password" : "current-password"}"></label>
      ${isNew ? `<label class="check"><input type="checkbox" name="ok" required>
        Jag godkänner att Campingliv sparar mina uppgifter för att appen ska fungera.</label>` : ""}
      <button class="btn primary" type="submit">${isNew ? "Skapa konto" : "Logga in"}</button>
      ${isNew ? "" : `<button class="link" type="button" id="forgot">Glömt lösenordet?</button>`}
    </form>
    <p class="center">${isNew
      ? `Har du redan konto? <button class="link" id="swap">Logga in</button>`
      : `Ny här? <button class="link" id="swap">Skapa konto</button>`}</p>
  </section>`;

  document.getElementById("swap").onclick = () => renderAuth(isNew ? "login" : "register");
  const form = document.getElementById("authForm");
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    const d = Object.fromEntries(new FormData(form));
    busy(btn, true);
    try {
      if (isNew) {
        const cred = await A.createUserWithEmailAndPassword(auth, d.email.trim(), d.pw);
        await A.updateProfile(cred.user, { displayName: d.name.trim() });
        await A.sendEmailVerification(cred.user);
      } else {
        await A.signInWithEmailAndPassword(auth, d.email.trim(), d.pw);
      }
    } catch (e) { toast(errText(e), true); busy(btn, false); }
  };
  const forgot = document.getElementById("forgot");
  if (forgot) forgot.onclick = async () => {
    const email = form.email.value.trim();
    if (!email) return toast("Skriv din e-post först.", true);
    try { await A.sendPasswordResetEmail(auth, email); toast("Vi har skickat ett mejl för att byta lösenord."); }
    catch (e) { toast(errText(e), true); }
  };
}

function renderVerify() {
  $nav.hidden = true;
  $main.innerHTML = `
  <section class="auth"><div class="card">
    <h2>Bekräfta din e-post</h2>
    <p>Vi har skickat ett mejl till <b>${esc(me.email)}</b>. Klicka på länken i mejlet.</p>
    <p><small>Hittar du det inte? Titta i skräpposten.</small></p>
    <button class="btn primary" id="done">Jag har bekräftat</button>
    <button class="btn" id="again">Skicka mejlet igen</button>
    <button class="link" id="out">Logga ut</button>
  </div></section>`;
  document.getElementById("done").onclick = async () => {
    await me.reload();
    if (auth.currentUser.emailVerified) {
      await auth.currentUser.getIdToken(true); // nytt token så reglerna ser bekräftelsen
      start(auth.currentUser);
    } else toast("Inte bekräftad ännu.", true);
  };
  document.getElementById("again").onclick = async () => {
    try { await A.sendEmailVerification(me); toast("Mejlet är skickat."); }
    catch (e) { toast(errText(e), true); }
  };
  document.getElementById("out").onclick = () => A.signOut(auth);
}

// ---------- Profil i databasen ----------
async function ensureProfile() {
  const ref = doc(db, "users", me.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) { profile = snap.data(); return; }
  const name = (me.displayName || me.email.split("@")[0]).slice(0, 50);
  profile = { displayName: name, displayNameLower: name.toLowerCase(), bio: "", vehicle: "",
    createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await setDoc(ref, profile);
}

// ---------- Flöde ----------
async function loadFeed() {
  const posts = new Map();
  const add = (snap) => snap.forEach((d) => posts.set(d.id, { id: d.id, ...d.data() }));
  let error = null;

  const jobs = [
    getDocs(query(collection(db, "posts"), where("visibility", "==", "public"),
      orderBy("createdAt", "desc"), limit(50))).then(add).catch((e) => { error = e; }),
    getDocs(query(collection(db, "posts"), where("authorId", "==", me.uid), limit(50))).then(add),
  ];
  const friends = await getDocs(collection(db, "users", me.uid, "friends"));
  friends.docs.slice(0, 30).forEach((f) => jobs.push(
    getDocs(query(collection(db, "posts"), where("authorId", "==", f.id),
      where("visibility", "in", ["public", "friends"]), limit(20))).then(add),
  ));
  await Promise.all(jobs);
  const list = [...posts.values()].sort((a, b) =>
    (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
  return { list, error };
}

// Naturfärger för inlägg utan bild (som Facebooks färgade inlägg)
const COVERS = [
  "linear-gradient(135deg,#2f5d46,#7fb08a)", "linear-gradient(135deg,#1f4e79,#5fa8d3)",
  "linear-gradient(135deg,#b4562e,#f2a65a)", "linear-gradient(135deg,#5b3f8c,#c47ab8)",
  "linear-gradient(135deg,#355c4a,#c9a66b)", "linear-gradient(135deg,#0f3b47,#2a9d8f)",
];
const coverFor = (id) => COVERS[[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % COVERS.length];
const initial = (n) => esc((n || "?").trim()[0]?.toUpperCase() || "?");

function postCard(p) {
  const v = VIS[p.visibility] || VIS.public;
  const mine = p.authorId === me.uid;
  // Rubrik (eller kort text) visas stort på en färgad yta
  const big = p.title || (p.text.length <= 120 ? p.text : "");
  const caption = p.title ? p.text : (big ? "" : p.text);
  return `
  <article class="ig" data-id="${esc(p.id)}">
    <header>
      <div class="ring"><div class="avatar">${initial(p.authorName)}</div></div>
      <div class="who"><b>${esc(p.authorName)}</b>
        <small>${p.place ? `📍 ${esc(p.place)}` : `${v.icon} ${v.label}`}</small></div>
      <button class="icon menu" aria-label="Mer">⋯</button>
      <div class="menu-pop" hidden>
        ${mine ? `<button data-act="delete">Ta bort inlägget</button>`
               : `<button data-act="report">Rapportera</button>`}
      </div>
    </header>
    ${big ? `<div class="cover" style="background:${coverFor(p.id)}">
        <p class="${big.length > 60 ? "long" : ""}">${esc(big)}</p>
        ${p.place ? `<span class="tag">📍 ${esc(p.place)}</span>` : ""}
        <div class="heart">❤️</div></div>` : ""}
    <div class="actions">
      <button class="icon like" data-act="like" aria-label="Gilla">🤍</button>
      <button class="icon" data-act="comments" aria-label="Kommentera">💬</button>
      <button class="icon" data-act="share" aria-label="Dela">📤</button>
      <span class="vis" title="${v.label}">${v.icon}</span>
    </div>
    <div class="body">
      <b class="likes" hidden></b>
      ${caption ? `<p class="caption ${caption.length > 160 ? "clip" : ""}"><b>${esc(p.authorName)}</b> ${esc(caption)}</p>
        ${caption.length > 160 ? `<button class="more">mer</button>` : ""}` : ""}
      <button class="show-comments" hidden></button>
      <div class="comments" hidden></div>
      <form class="add-comment"><div class="avatar sm">${initial(profile.displayName)}</div>
        <input name="t" placeholder="Lägg till en kommentar…" maxlength="2000" required>
        <button class="post-btn">Publicera</button></form>
      <time>${timeAgo(p.createdAt)}</time>
    </div>
  </article>`;
}

let feedFilter = null; // visa bara en väns inlägg

async function renderFeed() {
  $main.innerHTML = `<div class="loading">Laddar flödet…</div>`;
  try {
    const [{ list, error }, friends] = await Promise.all([
      loadFeed(), getDocs(collection(db, "users", me.uid, "friends")).catch(() => ({ docs: [] }))]);
    const shown = feedFilter ? list.filter((p) => p.authorId === feedFilter) : list;
    const fName = friends.docs.find((d) => d.id === feedFilter)?.data().name;
    $main.innerHTML = `
      <div class="topbar"><span class="logo-text">Campingliv</span>
        <a class="icon" href="#/vanner" aria-label="Vänner">👥</a></div>
      <div class="stories">
        <a class="story" href="#/skapa"><div class="ring add"><div class="avatar">${initial(profile.displayName)}</div><i>＋</i></div><span>Din resa</span></a>
        ${friends.docs.map((d) => `<button class="story ${feedFilter === d.id ? "on" : ""}" data-friend="${esc(d.id)}">
          <div class="ring"><div class="avatar">${initial(d.data().name)}</div></div>
          <span>${esc(d.data().name.split(" ")[0])}</span></button>`).join("")}
        ${friends.docs.length ? "" : `<a class="story" href="#/vanner"><div class="ring ghost"><div class="avatar">👥</div></div><span>Hitta vänner</span></a>`}
      </div>
      <a class="composer" href="#/skapa"><div class="avatar">${initial(profile.displayName)}</div>
        <span>Vad händer på campingen, ${esc(profile.displayName.split(" ")[0])}?</span></a>
      ${feedFilter ? `<div class="filter">Visar bara ${esc(fName || "vän")} <button class="link" id="clearFilter">Visa alla</button></div>` : ""}
      ${error ? indexHelp(error) || `<div class="card notice">Offentliga inlägg kunde inte laddas: ${esc(errText(error))}</div>` : ""}
      ${shown.length ? shown.map(postCard).join("") : `
        <div class="card empty"><p>Inga inlägg ännu.</p>
        <a class="btn primary" href="#/skapa">Skriv ditt första inlägg</a></div>`}`;
    $main.querySelectorAll("[data-friend]").forEach((b) => b.onclick = () => {
      feedFilter = feedFilter === b.dataset.friend ? null : b.dataset.friend; renderFeed();
    });
    const clr = document.getElementById("clearFilter");
    if (clr) clr.onclick = () => { feedFilter = null; renderFeed(); };
    $main.querySelectorAll(".ig").forEach((el) => wirePost(el, list.find((p) => p.id === el.dataset.id)));
  } catch (e) {
    $main.innerHTML = indexHelp(e) || `<div class="card notice">${esc(errText(e))}</div>`;
  }
}

async function wirePost(el, p) {
  const likeBtn = el.querySelector(".like");
  const likesEl = el.querySelector(".likes");
  const likesCol = collection(db, "posts", p.id, "likes");
  const commentsCol = collection(db, "posts", p.id, "comments");
  const myLike = doc(db, "posts", p.id, "likes", me.uid);
  const showBtn = el.querySelector(".show-comments");
  const box = el.querySelector(".comments");
  let liked = false, count = 0, nComments = 0;

  const paint = () => {
    likeBtn.textContent = liked ? "❤️" : "🤍";
    likeBtn.classList.toggle("on", liked);
    likesEl.hidden = count === 0;
    likesEl.textContent = count === 1 ? "1 gillning" : `${count} gillningar`;
  };
  const paintComments = () => {
    showBtn.hidden = nComments === 0 || !box.hidden;
    showBtn.textContent = nComments === 1 ? "Visa 1 kommentar" : `Visa alla ${nComments} kommentarer`;
  };
  Promise.all([getCountFromServer(likesCol), getDoc(myLike), getCountFromServer(commentsCol)])
    .then(([c, mine, cc]) => {
      count = c.data().count; liked = mine.exists(); nComments = cc.data().count;
      paint(); paintComments();
    }).catch(() => {});

  async function toggleLike(force) {
    if (force && liked) return;
    likeBtn.disabled = true;
    try {
      if (liked) { await deleteDoc(myLike); liked = false; count--; }
      else { await setDoc(myLike, { createdAt: serverTimestamp() }); liked = true; count++; }
      paint();
    } catch (e) { toast(errText(e), true); }
    likeBtn.disabled = false;
  }
  likeBtn.onclick = () => {
    likeBtn.classList.remove("pop"); void likeBtn.offsetWidth; likeBtn.classList.add("pop");
    toggleLike();
  };

  // Dubbeltryck på bilden = gilla (som Instagram)
  const cover = el.querySelector(".cover");
  if (cover) {
    let last = 0;
    cover.addEventListener("click", () => {
      const now = Date.now();
      if (now - last < 350) {
        const h = cover.querySelector(".heart");
        h.classList.remove("show"); void h.offsetWidth; h.classList.add("show");
        toggleLike(true);
      }
      last = now;
    });
  }

  const more = el.querySelector(".more");
  if (more) more.onclick = () => { el.querySelector(".caption").classList.remove("clip"); more.remove(); };

  el.querySelector("[data-act=share]").onclick = async () => {
    const text = [p.title, p.place && `📍 ${p.place}`, p.text].filter(Boolean).join("\n");
    try {
      if (navigator.share) await navigator.share({ title: p.title || "Campingliv", text, url: location.origin });
      else { await navigator.clipboard.writeText(`${text}\n${location.origin}`); toast("Kopierat!"); }
    } catch { /* användaren avbröt */ }
  };

  const pop = el.querySelector(".menu-pop");
  el.querySelector(".menu").onclick = () => { pop.hidden = !pop.hidden; };
  pop.onclick = async (ev) => {
    const act = ev.target.dataset.act;
    pop.hidden = true;
    if (act === "delete" && confirm("Ta bort inlägget?")) {
      try { await deleteDoc(doc(db, "posts", p.id)); el.remove(); toast("Inlägget är borttaget."); }
      catch (e) { toast(errText(e), true); }
    }
    if (act === "report") {
      const reason = prompt("Varför vill du rapportera inlägget?");
      if (!reason) return;
      try {
        await addDoc(collection(db, "reports"), { reporterId: me.uid, type: "post",
          targetId: p.id, reason: reason.slice(0, 500), createdAt: serverTimestamp() });
        toast("Tack! Vi tittar på det.");
      } catch (e) { toast(errText(e), true); }
    }
  };

  const openComments = async () => {
    box.hidden = false; paintComments();
    nComments = await renderComments(box, p, () => { nComments--; });
  };
  showBtn.onclick = openComments;
  el.querySelector("[data-act=comments]").onclick = () => {
    if (box.hidden && nComments) openComments();
    el.querySelector(".add-comment input").focus();
  };

  const f = el.querySelector(".add-comment");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector(".post-btn"); btn.disabled = true;
    try {
      await addDoc(commentsCol, { authorId: me.uid, authorName: profile.displayName,
        text: f.t.value.trim(), createdAt: serverTimestamp() });
      f.reset(); nComments++;
      await openComments();
    } catch (e) { toast(errText(e), true); }
    btn.disabled = false;
  };
}

// Visar kommentarerna. Returnerar antalet.
async function renderComments(box, p) {
  box.innerHTML = `<small>Laddar…</small>`;
  const col = collection(db, "posts", p.id, "comments");
  try {
    const snap = await getDocs(query(col, orderBy("createdAt", "asc"), limit(100)));
    box.innerHTML = snap.docs.map((d) => {
      const c = d.data();
      const canDel = c.authorId === me.uid || p.authorId === me.uid;
      return `<div class="comment"><p><b>${esc(c.authorName)}</b> ${esc(c.text)}</p>
        <small>${timeAgo(c.createdAt)}${canDel ? ` · <button class="link" data-del="${d.id}">Ta bort</button>` : ""}</small></div>`;
    }).join("");
    box.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      try { await deleteDoc(doc(col, b.dataset.del)); b.closest(".comment").remove(); }
      catch (e) { toast(errText(e), true); }
    });
    return snap.size;
  } catch (e) { box.innerHTML = `<small>${esc(errText(e))}</small>`; return 0; }
}

// ---------- Skapa inlägg ----------
function renderCreate() {
  $main.innerHTML = `
  <h1 class="page">Nytt inlägg</h1>
  <form class="card" id="postForm">
    <label>Rubrik<input name="title" maxlength="150" placeholder="T.ex. Första natten vid Vättern"></label>
    <label>Plats<input name="place" maxlength="150" placeholder="Camping eller ställplats (valfritt)" value="${esc(prefillPlace)}"></label>
    <label>Berätta<textarea name="text" rows="6" maxlength="5000" required placeholder="Hur var dagen?"></textarea></label>
    <label>Vem får se inlägget?
      <select name="visibility">
        <option value="public">🌍 Offentligt – alla</option>
        <option value="friends" selected>👥 Endast vänner</option>
        <option value="private">🔒 Privat – bara jag</option>
      </select></label>
    <p class="muted">📷 Bilder och film kommer i nästa steg.</p>
    <button class="btn primary" type="submit">Publicera</button>
  </form>`;
  prefillPlace = "";
  const f = document.getElementById("postForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector("button"); busy(btn, true);
    const d = Object.fromEntries(new FormData(f));
    try {
      await addDoc(collection(db, "posts"), {
        authorId: me.uid, authorName: profile.displayName,
        title: d.title.trim(), place: d.place.trim(), text: d.text.trim(),
        visibility: d.visibility, createdAt: serverTimestamp(),
      });
      toast("Inlägget är publicerat!");
      location.hash = "#/flode";
    } catch (e) { toast(errText(e), true); busy(btn, false); }
  };
}

// ---------- Vänner ----------
async function renderFriends() {
  $main.innerHTML = `<div class="loading">Laddar vänner…</div>`;
  try {
    const [friends, incoming, outgoing] = await Promise.all([
      getDocs(collection(db, "users", me.uid, "friends")),
      getDocs(query(collection(db, "friendRequests"), where("to", "==", me.uid))),
      getDocs(query(collection(db, "friendRequests"), where("from", "==", me.uid))),
    ]);
    const friendIds = new Set(friends.docs.map((d) => d.id));
    const pendingTo = new Set(outgoing.docs.map((d) => d.data().to));

    $main.innerHTML = `
    <h1 class="page">Vänner</h1>
    <form class="card row" id="search">
      <input name="q" placeholder="Sök på namn…" minlength="2" required>
      <button class="btn primary">Sök</button>
    </form>
    <div id="results"></div>
    ${incoming.size ? `<h2>Vänförfrågningar</h2>${incoming.docs.map((d) => {
      const r = d.data();
      return `<div class="card person"><b>${esc(r.fromName)}</b>
        <span><button class="btn primary" data-accept="${d.id}">Godkänn</button>
        <button class="btn" data-decline="${d.id}">Neka</button></span></div>`;
    }).join("")}` : ""}
    <h2>Mina vänner (${friends.size})</h2>
    ${friends.size ? friends.docs.map((d) => `<div class="card person"><b>${esc(d.data().name)}</b>
      <button class="link" data-remove="${d.id}">Ta bort</button></div>`).join("")
      : `<p class="muted">Du har inga vänner här ännu. Sök efter någon ovan.</p>`}
    ${outgoing.size ? `<h2>Skickade förfrågningar</h2>${outgoing.docs.map((d) => `
      <div class="card person"><b>${esc(d.data().toName)}</b>
      <button class="link" data-cancel="${d.id}">Ångra</button></div>`).join("")}` : ""}`;

    document.getElementById("search").onsubmit = async (ev) => {
      ev.preventDefault();
      const q = ev.target.q.value.trim().toLowerCase();
      const res = await getDocs(query(collection(db, "users"),
        where("displayNameLower", ">=", q), where("displayNameLower", "<=", q + ""), limit(20)));
      const box = document.getElementById("results");
      const people = res.docs.filter((d) => d.id !== me.uid);
      box.innerHTML = people.length ? people.map((d) => {
        const u = d.data();
        const state = friendIds.has(d.id) ? `<small>Vän</small>`
          : pendingTo.has(d.id) ? `<small>Förfrågan skickad</small>`
          : `<button class="btn primary" data-add="${d.id}" data-name="${esc(u.displayName)}">Lägg till</button>`;
        return `<div class="card person"><div><b>${esc(u.displayName)}</b>
          ${u.vehicle ? `<small>${esc(u.vehicle)}</small>` : ""}</div>${state}</div>`;
      }).join("") : `<p class="muted">Ingen hittades.</p>`;
      box.querySelectorAll("[data-add]").forEach((b) => b.onclick = async () => {
        busy(b, true);
        try {
          await setDoc(doc(db, "friendRequests", `${me.uid}_${b.dataset.add}`), {
            from: me.uid, to: b.dataset.add, fromName: profile.displayName,
            toName: b.dataset.name, createdAt: serverTimestamp() });
          toast("Vänförfrågan skickad!"); renderFriends();
        } catch (e) { toast(errText(e), true); busy(b, false); }
      });
    };

    $main.querySelectorAll("[data-accept]").forEach((b) => b.onclick = async () => {
      const r = incoming.docs.find((d) => d.id === b.dataset.accept).data();
      const batch = writeBatch(db);
      batch.set(doc(db, "users", me.uid, "friends", r.from), { name: r.fromName, since: serverTimestamp() });
      batch.set(doc(db, "users", r.from, "friends", me.uid), { name: profile.displayName, since: serverTimestamp() });
      batch.delete(doc(db, "friendRequests", b.dataset.accept));
      try { await batch.commit(); toast("Ni är nu vänner!"); renderFriends(); }
      catch (e) { toast(errText(e), true); }
    });
    const del = (attr) => $main.querySelectorAll(`[data-${attr}]`).forEach((b) => b.onclick = async () => {
      try { await deleteDoc(doc(db, "friendRequests", b.dataset[attr])); renderFriends(); }
      catch (e) { toast(errText(e), true); }
    });
    del("decline"); del("cancel");
    $main.querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
      if (!confirm("Ta bort vännen?")) return;
      const batch = writeBatch(db);
      batch.delete(doc(db, "users", me.uid, "friends", b.dataset.remove));
      batch.delete(doc(db, "users", b.dataset.remove, "friends", me.uid));
      try { await batch.commit(); renderFriends(); } catch (e) { toast(errText(e), true); }
    });
  } catch (e) { $main.innerHTML = `<div class="card notice">${esc(errText(e))}</div>`; }
}

// ---------- Profil ----------
function renderProfile() {
  $main.innerHTML = `
  <h1 class="page">Profil</h1>
  <div class="card profile-head">
    <div class="avatar big">${esc(profile.displayName[0].toUpperCase())}</div>
    <div><b>${esc(profile.displayName)}</b><small>${esc(me.email)}</small></div>
  </div>
  <a class="card linkrow" href="#/vanner">👥 Vänner och förfrågningar</a>
  <form class="card" id="profForm">
    <label>Namn<input name="displayName" required minlength="2" maxlength="50" value="${esc(profile.displayName)}"></label>
    <label>Om mig<textarea name="bio" rows="3" maxlength="500">${esc(profile.bio)}</textarea></label>
    <label>Fordon<input name="vehicle" maxlength="80" value="${esc(profile.vehicle)}" placeholder="T.ex. Husbil, Adria Coral"></label>
    <button class="btn primary" type="submit">Spara</button>
  </form>
  <button class="btn wide" id="logout">Logga ut</button>`;
  const f = document.getElementById("profForm");
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = f.querySelector("button"); busy(btn, true);
    const d = Object.fromEntries(new FormData(f));
    const next = { ...profile, displayName: d.displayName.trim(),
      displayNameLower: d.displayName.trim().toLowerCase(), bio: d.bio.trim(),
      vehicle: d.vehicle.trim(), updatedAt: serverTimestamp() };
    try { await setDoc(doc(db, "users", me.uid), next); profile = next; toast("Sparat!"); renderProfile(); }
    catch (e) { toast(errText(e), true); busy(btn, false); }
  };
  document.getElementById("logout").onclick = () => A.signOut(auth);
}

function renderSoon(title, text) {
  $main.innerHTML = `<h1 class="page">${title}</h1>
    <div class="card empty"><p>${text}</p><p class="muted">Kommer i nästa steg.</p></div>`;
}

// ---------- Navigering ----------
const routes = {
  "#/flode": renderFeed,
  "#/karta": () => renderMap($main, (name) => { prefillPlace = name; location.hash = "#/skapa"; }),
  "#/skapa": renderCreate,
  "#/resor": () => renderSoon("Resor", "🚐 Här skapar du resor med rutt och kostnader."),
  "#/profil": renderProfile,
  "#/vanner": renderFriends,
};

function route() {
  if (!me || !profile) return;
  const h = routes[location.hash] ? location.hash : "#/flode";
  $nav.hidden = false;
  $nav.querySelectorAll("a").forEach((a) =>
    a.classList.toggle("on", a.getAttribute("href") === h || (h === "#/vanner" && a.getAttribute("href") === "#/profil")));
  document.body.classList.toggle("on-map", h === "#/karta");
  routes[h]();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

async function start(user) {
  me = user; profile = null;
  if (!user) return renderAuth();
  if (!user.emailVerified) return renderVerify();
  $main.innerHTML = `<div class="loading">Startar…</div>`;
  try { await ensureProfile(); route(); }
  catch (e) { $main.innerHTML = `<div class="card notice">${esc(errText(e))}</div>`; }
}

A.onAuthStateChanged(auth, start);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
