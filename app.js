// Shop data lives in shop.json — edit that file to change avatars, prices and terms.
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value") n.value = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400); }
function safeLink(u) { if (!u || typeof u !== "string") return null; try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } }
async function copyText(text, msg = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast("Select the text and copy it manually"); }
}

const STATES = { available: ["Available", "ok"], reserved: ["Reserved", "warn"], sold: ["Sold", "bad"] };
const PLATFORMS = { pc: "PC", quest: "Quest", both: "PC + Quest" };
const S = { shop: null, tab: "shop", cat: "All", form: {}, sent: null };
const money = (n) => (S.shop?.currency ?? "$") + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const hasPrice = (a) => a.price != null && a.price !== "";
const avatars = () => (S.shop?.avatars || []).filter((a) => a && a.name);

function renderHeader() {
  const s = S.shop;
  $("studio-name").textContent = s.name || "Adopt-Studio";
  $("studio-tag").textContent = s.tagline || "";
  document.title = s.name || "Adopt-Studio";
  const avail = avatars().filter((a) => (a.state || "available") === "available").length;
  const b = $("avail-badge"); b.hidden = false;
  b.className = "badge " + (avail ? "open" : "closed");
  b.textContent = avail ? `${avail} avatar${avail === 1 ? "" : "s"} available` : "Sold out for now";
  const c = $("contact"); c.replaceChildren();
  if (s.discord) c.append(el("span", {}, "Discord ", el("code", {}, s.discord)));
  if (s.email) c.append(el("span", {}, "Email ", el("code", {}, s.email)));
  if (s.otherContact) c.append(el("span", {}, s.otherContact));
}

function viewShop() {
  const list = avatars();
  const cats = ["All", ...new Set(list.map((a) => a.category || "Other"))];
  if (!cats.includes(S.cat)) S.cat = "All";
  const shown = list.filter((a) => S.cat === "All" || (a.category || "Other") === S.cat)
    .sort((a, b) => (a.state === "sold") - (b.state === "sold"));
  return el("section", { class: "wrap", style: "gap:16px" },
    el("div", { class: "section-head" }, el("div", {}, el("h2", {}, "Prebuilt avatars"), el("p", {}, "Ready-made avatars you can buy right away. Each one is sold as listed."))),
    cats.length > 2 ? el("div", { class: "chips" }, cats.map((c) => el("button", { class: "chip", type: "button", "aria-pressed": String(S.cat === c), onclick: () => { S.cat = c; render(); } }, c))) : null,
    list.length ? el("div", { class: "grid" }, shown.map(card))
      : el("div", { class: "empty" }, el("h3", {}, "New avatars coming soon"), el("p", {}, "Nothing is for sale right now. Check back later.")));
}
function card(a) {
  const [label, tone] = STATES[a.state] || STATES.available;
  const link = safeLink(a.link);
  const img = a.image ? safeLink(a.image) : null;
  return el("article", { class: "card" },
    el("div", { class: "thumb" }, img ? el("img", { src: img, alt: "Picture of " + a.name, loading: "lazy" }) : el("span", { class: "ph" }, a.name.slice(0, 1).toUpperCase()),
      el("span", { class: "state pill " + tone }, label)),
    el("div", { class: "body" },
      el("h3", {}, a.name),
      el("div", { class: "price" }, hasPrice(a) ? money(a.price) : "Ask for price", a.priceNote ? el("small", {}, " " + a.priceNote) : null),
      el("div", { class: "pills" }, el("span", { class: "pill accent" }, a.category || "Other"), a.platform ? el("span", { class: "pill info" }, PLATFORMS[a.platform] || a.platform) : null,
        (a.features || []).map((f) => el("span", { class: "pill" }, f))),
      a.description ? el("p", { class: "desc" }, a.description) : null,
      el("div", { class: "foot" },
        a.model ? el("button", { class: "btn small", type: "button", onclick: () => open3D(a) }, "View in 3D") : null,
        a.state !== "sold" && link ? el("a", { class: "btn primary small", href: link, target: "_blank", rel: "noopener" }, "Buy") : null,
        a.state !== "sold" ? el("button", { class: "btn small", type: "button", onclick: () => { S.form = { item: a.name }; S.sent = null; go("buy"); } }, link ? "Ask about it" : "Request to buy") : null)));
}

// 3D viewer: Google's <model-viewer>, loaded only the first time someone opens a model.
let viewerLib;
function loadViewerLib() {
  return (viewerLib ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.type = "module";
    s.src = "https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js";
    s.onload = () => customElements.whenDefined("model-viewer").then(ok);
    s.onerror = () => { viewerLib = null; no(); };
    document.head.append(s);
  }));
}
function open3D(a) {
  const src = safeLink(a.model);
  if (!src) return;
  const stage = el("div", { class: "viewer-stage" }, el("p", { class: "note" }, "Loading 3D viewer…"));
  const close = () => { ov.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const ov = el("div", { class: "viewer-ov", role: "dialog", "aria-modal": "true", "aria-label": "3D view of " + a.name, onclick: (e) => { if (e.target === ov) close(); } },
    el("div", { class: "viewer" },
      el("div", { class: "viewer-head" }, el("h3", {}, a.name), el("button", { class: "btn small", type: "button", "aria-label": "Close 3D view", onclick: close }, "✕")),
      stage,
      el("p", { class: "note" }, "Drag to rotate · pinch or scroll to zoom · 3D preview, the avatar you buy may have more detail")));
  document.body.append(ov); document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  loadViewerLib().then(() => {
    const mv = el("model-viewer", { src, alt: "3D model of " + a.name, "camera-controls": true, "auto-rotate": true, "auto-rotate-delay": "1500",
      ar: true, "ar-modes": "webxr scene-viewer quick-look", "shadow-intensity": "1", exposure: "1", "touch-action": "pan-y",
      poster: a.image ? safeLink(a.image) : null, style: "width:100%;height:100%;background:transparent" });
    mv.addEventListener("error", () => stage.replaceChildren(el("p", { class: "note" }, "Couldn't load this 3D model. Try again later.")));
    stage.replaceChildren(mv);
  }).catch(() => stage.replaceChildren(el("p", { class: "note" }, "Couldn't load the 3D viewer. Check your connection and try again.")));
}

function viewBuy() {
  const s = S.shop;
  return el("section", { class: "wrap", style: "gap:18px" },
    el("div", { class: "section-head" }, el("div", {}, el("h2", {}, "How to buy"),
      el("p", {}, "Tap Buy on an avatar to go to its store page, or fill in the form to get a message you can send me."))),
    el("div", { class: "two" }, requestForm(),
      el("div", { class: "panel" }, el("h3", { style: "font:700 16px var(--font-display);margin:0" }, "Payment and terms"),
        s.payment ? el("p", { class: "terms" }, el("b", {}, "Payment: "), s.payment) : null,
        s.terms ? el("p", { class: "terms" }, s.terms) : el("p", { class: "note" }, "Ask about terms when you get in touch."))));
}
function contactLine() {
  const s = S.shop;
  return s.discord ? `on Discord (${s.discord})` : s.email ? `by email (${s.email})` : s.otherContact ? `(${s.otherContact})` : "";
}
function requestForm() {
  const s = S.shop;
  const options = avatars().filter((a) => a.state !== "sold").map((a) => a.name);
  if (S.sent) return el("div", { class: "panel" }, el("div", { class: "okmsg" }, "Your request is ready to send."),
    el("p", { class: "note" }, "Copy it and send it to me " + contactLine() + "."),
    el("pre", { class: "msg" }, S.sent),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      el("button", { class: "btn primary", type: "button", onclick: () => copyText(S.sent, "Request copied") }, "Copy request"),
      s.discord ? el("button", { class: "btn", type: "button", onclick: () => copyText(s.discord, "Discord name copied") }, "Copy Discord name") : null,
      el("button", { class: "btn", type: "button", onclick: () => { S.sent = null; S.form = {}; render(); } }, "Start another")));
  if (!options.length) return el("div", { class: "panel" }, el("h3", { style: "font:700 16px var(--font-display);margin:0" }, "Nothing for sale right now"),
    el("p", { class: "note" }, "All avatars are sold out. Check back soon."));
  const f = (id, label, input, hint) => el("label", { class: "f", for: id }, label, hint ? el("span", { class: "hint" }, hint) : null, input);
  return el("form", { class: "panel", novalidate: true, onsubmit: submit },
    el("h3", { style: "font:700 16px var(--font-display);margin:0" }, "Request to buy an avatar"),
    el("div", { class: "row2" },
      f("rq-name", "Your name", el("input", { id: "rq-name", type: "text", autocomplete: "name", value: S.form.name || "" })),
      f("rq-contact", "Your Discord or email", el("input", { id: "rq-contact", type: "text", value: S.form.contact || "" }), "So I can reply")),
    el("div", { class: "row2" },
      f("rq-item", "Which avatar", el("select", { id: "rq-item" }, el("option", { value: "" }, "Choose an avatar"),
        options.map((n) => el("option", { value: n, selected: S.form.item === n }, n)))),
      f("rq-platform", "Platform", el("select", { id: "rq-platform" }, Object.entries(PLATFORMS).map(([v, l]) => el("option", { value: v, selected: (S.form.platform || "both") === v }, l))))),
    f("rq-details", "Message", el("textarea", { id: "rq-details", placeholder: "Questions, how you'd like to pay, anything else…" }, S.form.details || "")),
    el("span", { class: "err", id: "rq-err", hidden: true }),
    el("div", {}, el("button", { class: "btn primary", type: "submit" }, "Create request")),
    el("p", { class: "note" }, "You'll get a ready-made message to copy and send to me" + (contactLine() ? " " + contactLine() : "") + "."));
}
function readForm() {
  const v = (id) => ($(id)?.value || "").trim();
  return { name: v("rq-name"), contact: v("rq-contact"), item: v("rq-item"), platform: v("rq-platform") || "both", details: v("rq-details") };
}
function submit(e) {
  e.preventDefault();
  const r = readForm(); S.form = r;
  const missing = [!r.name && "your name", !r.contact && "a Discord name or email", !r.item && "which avatar you want"].filter(Boolean);
  if (missing.length) { const er = $("rq-err"); er.textContent = "Please add " + missing.join(", ") + "."; er.hidden = false; return; }
  const a = avatars().find((x) => x.name === r.item);
  S.sent = [`Avatar purchase request — ${S.shop.name}`, `Name: ${r.name}`, `Contact: ${r.contact}`,
    `Avatar: ${r.item}${a && hasPrice(a) ? " (" + money(a.price) + ")" : ""}`, `Platform: ${PLATFORMS[r.platform]}`, r.details ? `\nMessage:\n${r.details}` : null].filter(Boolean).join("\n");
  render();
}

function go(tab) { S.tab = tab; try { history.replaceState(null, "", "#" + tab); } catch {} render(); window.scrollTo({ top: 0 }); }
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
function render() {
  if (!S.shop) return;
  if (S.tab === "buy" && !S.sent && $("rq-name")) S.form = { ...S.form, ...readForm() };
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  renderHeader();
  $("view").replaceChildren(S.tab === "buy" ? viewBuy() : viewShop());
}

if (location.hash === "#buy") S.tab = "buy";
fetch("shop.json", { cache: "no-cache" })
  .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((data) => { S.shop = data; render(); })
  .catch(() => { $("view").replaceChildren(el("div", { class: "banner" }, "Couldn't load the shop. Refresh the page to try again.")); });
