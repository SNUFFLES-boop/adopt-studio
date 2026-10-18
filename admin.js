// Owner-only shop editor. Reads and writes shop.json and images/ through the GitHub API
// using a fine-grained token that only the owner has. Nothing here works without it.
const OWNER = "SNUFFLES-boop";
const REPO = "adopt-studio";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TOKEN_KEY = "adopt-studio.token";

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
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600); }
function banner(m) { $("banner").textContent = m || ""; $("banner").hidden = !m; }
function busy(m) { $("saving-text").textContent = m || "Saving…"; $("saving").hidden = !m; }

const STATES = { available: "Available", reserved: "Reserved", sold: "Sold" };
const PLATFORMS = { pc: "PC", quest: "Quest", both: "PC + Quest" };
const S = { token: null, branch: "main", shop: null, sha: null, tab: "avatars", user: null };

/* ---------- token storage ---------- */
function loadToken() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function saveToken(t, remember) {
  try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t); } catch {}
}
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch {} }

/* ---------- GitHub API ---------- */
async function gh(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + S.token, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.message || res.statusText); e.status = res.status; throw e; }
  return body;
}
const b64encodeText = (s) => { const bytes = new TextEncoder().encode(s); let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
const b64decodeText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function loadShop() {
  const f = await gh(`/contents/shop.json?ref=${encodeURIComponent(S.branch)}`);
  S.sha = f.sha;
  S.shop = JSON.parse(b64decodeText(f.content));
  if (!Array.isArray(S.shop.avatars)) S.shop.avatars = [];
}
async function saveShop(message) {
  const content = b64encodeText(JSON.stringify(S.shop, null, 2) + "\n");
  try {
    const r = await gh("/contents/shop.json", { method: "PUT", body: JSON.stringify({ message, content, sha: S.sha, branch: S.branch }) });
    S.sha = r.content.sha;
  } catch (e) {
    if (e.status === 409 || e.status === 422) { await loadShop(); render(); throw Object.assign(new Error("The shop changed somewhere else. I reloaded it — make your change again."), { friendly: true }); }
    throw e;
  }
}
async function uploadImage(file, name) {
  const blob = await shrink(file);
  const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
  const slug = (name || "avatar").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "avatar";
  const path = `images/${slug}-${Date.now().toString(36)}.${ext}`;
  const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(blob); });
  await gh("/contents/" + path, { method: "PUT", body: JSON.stringify({ message: "Add picture for " + (name || "avatar"), content: data, branch: S.branch }) });
  return path;
}
async function uploadModel(file, name) {
  const slug = (name || "avatar").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "avatar";
  const path = `models/${slug}-${Date.now().toString(36)}.glb`;
  const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(file); });
  try {
    await gh("/contents/" + path, { method: "PUT", body: JSON.stringify({ message: "Add 3D model for " + (name || "avatar"), content: data, branch: S.branch }) });
  } catch (e) {
    if (e.status !== 401) throw Object.assign(new Error("GitHub didn't accept the 3D file. Try a smaller preview version (under 15 MB)."), { friendly: true });
    throw e;
  }
  return path;
}
const MODEL_MAX = 25 * 1024 * 1024;
async function checkModel(file) {
  if (file.size > MODEL_MAX) return "That 3D file is over 25 MB. Export a lighter preview version (fewer polygons, smaller textures).";
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (String.fromCharCode(...head) !== "glTF") return "That isn't a .glb file. Export the avatar from Unity or Blender as glTF Binary (.glb).";
  return null;
}
async function deleteImage(path) {
  if (!path || !/^(images|models)\//.test(path)) return;
  try {
    const f = await gh(`/contents/${path}?ref=${encodeURIComponent(S.branch)}`);
    await gh("/contents/" + path, { method: "DELETE", body: JSON.stringify({ message: "Remove " + path, sha: f.sha, branch: S.branch }) });
  } catch {}
}
// Resize big photos so the website stays fast (max 1400px on the long side).
async function shrink(file) {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return file;
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  if (scale === 1 && file.size < 900 * 1024) return file;
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise((ok) => c.toBlob((b) => ok(b || file), "image/webp", 0.86));
}

/* ---------- sign in ---------- */
async function signIn(token) {
  S.token = token;
  const repo = await gh("");
  if (!repo.permissions?.push) { const e = new Error("no-push"); e.status = 403; throw e; }
  S.branch = repo.default_branch || "main";
  try {
    const pages = await gh("/pages");
    const src = pages?.source?.branch;
    if (src && src !== S.branch) banner(`Your website is published from the "${src}" branch, but this page saves to "${S.branch}", so changes won't show yet. Fix it: GitHub → adopt-studio → Settings → Pages → Branch: ${S.branch} → Save.`);
  } catch {}
  await loadShop();
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("token").value.trim(); const err = $("login-err"); err.hidden = true;
  if (!t) { err.textContent = "Paste your GitHub key first."; err.hidden = false; return; }
  busy("Signing in…");
  try { await signIn(t); saveToken(t, $("remember").checked); $("token").value = ""; showApp(); }
  catch (ex) {
    S.token = null;
    err.textContent = ex.status === 401 ? "GitHub didn't accept that key. Check you copied all of it, or make a new one."
      : ex.status === 403 || ex.status === 404 ? "That key can't change adopt-studio. Make sure you picked the adopt-studio repository and set Contents to Read and write."
      : "Couldn't reach GitHub. Check your connection and try again.";
    err.hidden = false;
  } finally { busy(); }
});
$("logout").addEventListener("click", () => { clearToken(); S.token = null; S.shop = null; $("app").hidden = true; $("login").hidden = false; banner(); });

/* ---------- views ---------- */
function showApp() { $("login").hidden = true; $("app").hidden = false; render(); }
function render() {
  const tabs = [["avatars", `Avatars (${S.shop.avatars.length})`], ["settings", "Shop settings"]];
  $("subtabs").replaceChildren(...tabs.map(([k, l]) => el("button", { class: "chip", type: "button", "aria-pressed": String(S.tab === k), onclick: () => { S.tab = k; render(); } }, l)));
  $("who").textContent = "Saving to " + OWNER + "/" + REPO;
  $("view").replaceChildren(S.tab === "settings" ? viewSettings() : viewAvatars());
}
const money = (n) => (S.shop.currency ?? "$") + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
function viewAvatars() {
  const list = S.shop.avatars;
  const head = el("div", { class: "section-head" }, el("div", {}, el("h2", {}, "Your avatars"), el("p", {}, "Add, edit, mark sold or delete. Each save updates the website.")),
    el("button", { class: "btn primary", type: "button", onclick: () => editAvatar(null) }, "+ Add avatar"));
  if (!list.length) return el("div", { class: "wrap", style: "gap:14px" }, head, el("div", { class: "empty" }, el("h3", {}, "No avatars yet"),
    el("p", {}, "Add your first prebuilt avatar with a picture, price and category."), el("button", { class: "btn primary", type: "button", onclick: () => editAvatar(null) }, "Add your first avatar")));
  return el("div", { class: "wrap", style: "gap:14px" }, head, el("div", { class: "grid" }, list.map((a, i) => {
    const tone = { available: "ok", reserved: "warn", sold: "bad" }[a.state] || "ok";
    return el("article", { class: "card" },
      el("div", { class: "thumb" }, a.image ? el("img", { src: a.image, alt: "", loading: "lazy" }) : el("span", { class: "ph" }, (a.name || "?").slice(0, 1).toUpperCase()),
        el("span", { class: "state pill " + tone }, STATES[a.state] || "Available")),
      el("div", { class: "body" }, el("h3", {}, a.name), el("div", { class: "price" }, a.price != null && a.price !== "" ? money(a.price) : "No price yet"),
        el("div", { class: "pills" }, el("span", { class: "pill accent" }, a.category || "Other"), a.platform ? el("span", { class: "pill info" }, PLATFORMS[a.platform]) : null, a.model ? el("span", { class: "pill" }, "3D") : null),
        el("div", { class: "foot" },
          el("button", { class: "btn small", type: "button", onclick: () => editAvatar(i) }, "Edit"),
          el("label", { class: "f", style: "flex-direction:row;align-items:center;gap:6px" },
            el("select", { "aria-label": "Availability of " + a.name, style: "padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);font-size:13px",
              onchange: (e) => quickState(i, e.target.value) }, Object.entries(STATES).map(([k, l]) => el("option", { value: k, selected: (a.state || "available") === k }, l)))))));
  })));
}
async function quickState(i, state) {
  const a = S.shop.avatars[i]; const prev = a.state;
  a.state = state; busy("Saving…");
  try { await saveShop(`Mark ${a.name} as ${STATES[state].toLowerCase()}`); toast(`${a.name} marked ${STATES[state].toLowerCase()}`); }
  catch (e) { a.state = prev; toast(e.friendly ? e.message : "Couldn't save. Try again."); }
  finally { busy(); render(); }
}
function viewSettings() {
  const s = S.shop;
  const rows = [["Shop name", s.name], ["Tagline", s.tagline], ["Currency", s.currency], ["Discord", s.discord || "Not set"], ["Email", s.email || "Not set"], ["Other contact", s.otherContact || "Not set"], ["Payment", s.payment]];
  return el("div", { class: "panel" }, el("div", { class: "section-head" }, el("h2", {}, "Shop settings"), el("button", { class: "btn primary", type: "button", onclick: editSettings }, "Edit settings")),
    el("div", { class: "tablewrap" }, el("table", { style: "min-width:0" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("th", { style: "width:34%" }, k), el("td", { style: "overflow-wrap:anywhere" }, v || "—")))))),
    el("p", { class: "note" }, "Terms of service are edited from the same button."));
}

/* ---------- edit sheet ---------- */
const sheet = { onSave: null, onDelete: null, file: undefined, model: undefined };
function openSheet({ title, fields, values = {}, onSave, onDelete }) {
  sheet.onSave = onSave; sheet.onDelete = onDelete; sheet.file = undefined; sheet.model = undefined;
  $("sheet-title").textContent = title;
  const form = $("sheet-form"); form.replaceChildren();
  for (const fd of fields) {
    const id = "sf-" + fd.key; const v = values[fd.key];
    let input;
    if (fd.type === "textarea") input = el("textarea", { id, style: fd.tall ? "min-height:260px" : null }, v ?? "");
    else if (fd.type === "select") input = el("select", { id }, fd.options.map(([ov, ol]) => el("option", { value: ov, selected: String(v ?? fd.default ?? "") === ov }, ol)));
    else if (fd.type === "image") {
      const pv = el("div", { class: "pv" }, v ? el("img", { src: v, alt: "" }) : "None");
      input = el("div", { class: "imgpick" }, pv, el("div", { style: "display:flex;flex-direction:column;gap:6px" },
        el("input", { id, type: "file", accept: "image/*", onchange: (e) => { const f = e.target.files[0]; if (!f) return; sheet.file = f; pv.replaceChildren(el("img", { src: URL.createObjectURL(f), alt: "" })); } }),
        el("button", { class: "btn small", type: "button", style: "align-self:start", onclick: () => { sheet.file = null; $(id).value = ""; pv.textContent = "None"; } }, "Remove picture")));
    } else if (fd.type === "model") {
      const info = el("span", { class: "note", id: "sf-model-info" }, v ? "Current: " + v.split("/").pop() : "No 3D model");
      input = el("div", { style: "display:flex;flex-direction:column;gap:6px" }, info,
        el("input", { id, type: "file", accept: ".glb,model/gltf-binary", onchange: async (e) => {
          const f = e.target.files[0]; if (!f) return;
          const problem = await checkModel(f);
          if (problem) { e.target.value = ""; sheet.model = undefined; info.textContent = problem; return; }
          sheet.model = f; info.textContent = `Ready to upload: ${f.name} (${(f.size / 1048576).toFixed(1)} MB)`;
        } }),
        el("button", { class: "btn small", type: "button", style: "align-self:start", onclick: () => { sheet.model = null; $(id).value = ""; info.textContent = "3D model will be removed"; } }, "Remove 3D model"));
    } else input = el("input", { id, type: fd.type || "text", value: Array.isArray(v) ? v.join(", ") : v ?? "", step: fd.type === "number" ? "0.01" : null, min: fd.type === "number" ? "0" : null, placeholder: fd.placeholder || null });
    form.append(el("label", { class: "f", for: fd.type === "image" ? null : id }, fd.label, fd.hint ? el("span", { class: "hint" }, fd.hint) : null, input));
  }
  form.append(el("span", { class: "err", id: "sf-err", hidden: true }));
  form._fields = fields;
  const del = $("sheet-del"); del.hidden = !onDelete; del.textContent = "Delete"; del.classList.remove("confirm");
  $("scrim").hidden = false; $("sheet").hidden = false;
  setTimeout(() => form.querySelector("input:not([type=file]),textarea,select")?.focus(), 30);
}
function closeSheet() { $("scrim").hidden = true; $("sheet").hidden = true; }
["sheet-x", "sheet-cancel", "scrim"].forEach((id) => $(id).addEventListener("click", closeSheet));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
$("sheet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = {};
  for (const fd of e.target._fields) {
    if (fd.type === "image" || fd.type === "model") continue;
    const n = $("sf-" + fd.key);
    if (fd.type === "number") out[fd.key] = n.value === "" ? "" : Number(n.value);
    else if (fd.type === "list") out[fd.key] = n.value.split(",").map((s) => s.trim()).filter(Boolean);
    else out[fd.key] = n.value.trim();
    if (fd.required && !out[fd.key]) { const er = $("sf-err"); er.textContent = fd.label + " is required."; er.hidden = false; return; }
  }
  $("sheet-save").disabled = true; busy("Saving to your website…");
  try { await sheet.onSave(out, sheet.file, sheet.model); closeSheet(); toast("Saved. The website updates in about a minute."); render(); }
  catch (ex) { const er = $("sf-err"); er.textContent = ex.friendly ? ex.message : ex.status === 401 ? "Your GitHub key expired or was deleted. Sign out and sign in with a new one." : "Couldn't save. Check your connection and try again."; er.hidden = false; }
  finally { $("sheet-save").disabled = false; busy(); }
});
$("sheet-del").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Tap again to delete"; return; }
  busy("Deleting…");
  try { await sheet.onDelete(); closeSheet(); toast("Deleted"); render(); }
  catch (ex) { toast(ex.friendly ? ex.message : "Couldn't delete. Try again."); }
  finally { busy(); }
});

function editAvatar(i) {
  const a = i == null ? null : S.shop.avatars[i];
  const cats = [...new Set(S.shop.avatars.map((x) => x.category).filter(Boolean))];
  openSheet({
    title: a ? "Edit avatar" : "Add avatar", values: a || {},
    fields: [
      { key: "name", label: "Avatar name", required: true },
      { key: "image", label: "Picture", type: "image" },
      { key: "model", label: "3D model (optional)", type: "model", hint: "A .glb preview so buyers can tap View in 3D. Anyone can download it, so use a lighter preview, not your full avatar." },
      { key: "category", label: "Category", hint: cats.length ? "Existing: " + cats.join(", ") : "e.g. Anime, Furry, Feline, Robot", placeholder: "Anime" },
      { key: "price", label: "Price (" + (S.shop.currency || "$") + ")", type: "number", hint: "Leave empty to show 'Ask for price'" },
      { key: "priceNote", label: "Price note", hint: "Optional, e.g. 'one copy only' or 'incl. Quest version'" },
      { key: "state", label: "Availability", type: "select", default: "available", options: Object.entries(STATES) },
      { key: "platform", label: "Platform", type: "select", default: "both", options: Object.entries(PLATFORMS) },
      { key: "features", label: "Features", type: "list", hint: "Separate with commas, e.g. toggles, phys bones, face tracking" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "link", label: "Store link", hint: "Booth, Gumroad, Payhip… Leave empty to take requests on Discord instead", placeholder: "https://" },
    ],
    onSave: async (d, file, modelFile) => {
      if (d.link && !/^https?:\/\//i.test(d.link)) d.link = "https://" + d.link;
      const oldImage = a?.image, oldModel = a?.model;
      let image = a?.image || "", model = a?.model || "";
      if (file) image = await uploadImage(file, d.name);
      else if (file === null) image = "";
      if (modelFile) { busy("Uploading 3D model…"); model = await uploadModel(modelFile, d.name); busy("Saving to your website…"); }
      else if (modelFile === null) model = "";
      const next = { ...(a || {}), ...d, image, model };
      for (const k of Object.keys(next)) if (next[k] === "" || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
      const before = S.shop.avatars.slice();
      if (a) S.shop.avatars[i] = next; else S.shop.avatars.push(next);
      try { await saveShop((a ? "Update " : "Add ") + next.name); }
      catch (e) { S.shop.avatars = before; throw e; }
      if (oldImage && oldImage !== image) deleteImage(oldImage);
      if (oldModel && oldModel !== model) deleteImage(oldModel);
    },
    onDelete: a ? async () => {
      const before = S.shop.avatars.slice();
      S.shop.avatars.splice(i, 1);
      try { await saveShop("Remove " + a.name); } catch (e) { S.shop.avatars = before; throw e; }
      deleteImage(a.image);
      deleteImage(a.model);
    } : null,
  });
}
function editSettings() {
  openSheet({
    title: "Shop settings", values: S.shop,
    fields: [
      { key: "name", label: "Shop name", required: true },
      { key: "tagline", label: "Tagline", type: "textarea" },
      { key: "currency", label: "Currency symbol", placeholder: "$" },
      { key: "discord", label: "Discord username", hint: "Shown to buyers so they can send you requests" },
      { key: "email", label: "Email", hint: "Optional" },
      { key: "otherContact", label: "Other contact", hint: "Optional, e.g. 'Twitter @name'" },
      { key: "payment", label: "Payment", type: "textarea", hint: "How and when buyers pay" },
      { key: "terms", label: "Terms of service", type: "textarea", tall: true },
    ],
    onSave: async (d) => {
      const before = { ...S.shop };
      Object.assign(S.shop, d);
      try { await saveShop("Update shop settings"); } catch (e) { S.shop = before; throw e; }
    },
  });
}

/* ---------- boot ---------- */
(async () => {
  const t = loadToken();
  if (!t) { $("login").hidden = false; return; }
  busy("Signing in…");
  try { await signIn(t); showApp(); }
  catch (e) { clearToken(); S.token = null; $("login").hidden = false; if (e.status === 401) banner("Your saved GitHub key no longer works. Sign in with a new one."); }
  finally { busy(); }
})();
