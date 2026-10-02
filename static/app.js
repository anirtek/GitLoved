/* ═══════════════════════════════════════════════════════════════════
   GitLoved — front-end. A faithful re-creation of the JetBrains
   Git plugin experience (New UI, dark).
   ═══════════════════════════════════════════════════════════════════ */
"use strict";

/* ── tiny helpers ─────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BRANCH_SVG = `<svg class="ic s" viewBox="0 0 16 16"><path class="st" d="M5 3.5a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0Zm0 9a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0Zm9-9a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0Z"/><path class="st" d="M3.3 5.2v6.1M12.7 5.3c0 2.5-2 3.2-4.2 3.6-1.7.3-3.4.7-4.2 2"/></svg>`;

async function api(path, params) {
  const q = params ? "?" + new URLSearchParams(params) : "";
  const r = await fetch("/api/" + path + q);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function post(path, body) {
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
/** Run a git action; refresh UI; balloon on success/failure. */
async function action(name, args, okTitle, okMsg) {
  try {
    const res = await post("action", { name, args });
    if (okTitle) balloon("ok", okTitle, okMsg ?? (res.output || "").trim().split("\n").slice(-3).join("\n"));
    await refreshAll();
    return res;
  } catch (e) {
    balloon("err", titleCase(name.replace(/_/g, " ")) + " failed", e.message);
    await refreshAll();
    throw e;
  }
}
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts = sameYear
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return d.toLocaleString(undefined, opts);
}
const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/* ── balloons (IDE notifications) ─────────────────────────────────── */
function balloon(kind, title, msg, ms = 6000) {
  const icon = kind === "ok" ? "✓" : kind === "err" ? "✕" : "ℹ";
  const b = el("div", `balloon ${kind}`,
    `<span class="b-icon">${icon}</span>
     <span style="min-width:0"><div class="b-title">${esc(title)}</div>
     ${msg ? `<div class="b-msg">${esc(msg)}</div>` : ""}</span>
     <button class="b-close">×</button>`);
  $(".b-close", b).onclick = () => b.remove();
  $("#balloons").append(b);
  if (kind !== "err") setTimeout(() => b.remove(), ms);
}

/* ── global state ─────────────────────────────────────────────────── */
const S = {
  summary: null,        // /api/summary
  status: { changes: [], unversioned: [], conflicts: [] },
  branches: null,
  log: { commits: [], head: null },
  logFilter: { search: "", branch: "", author: "" },
  checked: new Set(),   // paths checked in the commit tree
  selection: null,      // selected file in commit tree {path, kind}
  selectedCommit: null,
  collapsed: new Set(),
};

/* ── boot ─────────────────────────────────────────────────────────── */
window.addEventListener("DOMContentLoaded", async () => {
  wireChrome();
  const rec = await api("recent").catch(() => ({ recent: [], open: null }));
  if (rec.open) {
    await enterProject();
  } else {
    showWelcome(rec.recent);
  }
});

function showWelcome(recent) {
  $("#welcome").classList.remove("hidden");
  $("#app").classList.add("hidden");
  const list = $("#recent-list");
  list.innerHTML = "";
  for (const r of recent) {
    const item = el("div", "recent-item" + (r.exists ? "" : " gone"),
      `<span class="project-avatar">${esc(r.name[0].toUpperCase())}</span>
       <span style="min-width:0"><div class="rp-name">${esc(r.name)}</div>
       <div class="rp-path">${esc(r.path)}</div></span>`);
    if (r.exists) item.onclick = () => openProject(r.path);
    list.append(item);
  }
  $("#w-open").onclick = () => browseDialog();
  $("#w-clone").onclick = () => cloneDialog();
}

async function openProject(path) {
  try {
    await post("open", { path });
    await enterProject();
  } catch (e) {
    balloon("err", "Cannot open project", e.message);
  }
}

async function enterProject() {
  $("#welcome").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await refreshAll();
  startPolling();
}

/* ── "Open…" file browser dialog ──────────────────────────────────── */
async function browseDialog(startPath) {
  let cur = null;
  const body = el("div");
  body.innerHTML = `
    <div class="fb-path" id="fb-path"></div>
    <div class="fb-list" id="fb-list"></div>
    <div class="dlg-note">Pick a directory that contains a Git repository (marked <b style="color:var(--green)">GIT</b>).</div>`;
  const d = dialog({
    title: "Open Project",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Open", primary: true, keep: true, onClick: async () => {
          if (!cur) return;
          if (!cur.isRepo) {
            const ok = await confirmDialog("Not a Git repository",
              `“${cur.path}” has no .git directory.\nRun “git init” here and open it?`, "Init and Open");
            if (!ok) return;
            await post("action", { name: "init", args: { path: cur.path } }).catch(e => balloon("err", "git init failed", e.message));
          }
          d.close();
          openProject(cur.path);
        } },
    ],
  });
  async function load(p) {
    const res = await api("browse", { path: p || "" });
    cur = res;
    $("#fb-path", body).textContent = res.path + (res.isRepo ? "   ✓ Git repository" : "");
    const list = $("#fb-list", body);
    list.innerHTML = "";
    if (res.parent) {
      const up = el("div", "fb-item", `<span>↰</span><span>..</span>`);
      up.onclick = () => load(res.parent);
      list.append(up);
    }
    for (const dnt of res.dirs) {
      const it = el("div", "fb-item",
        `<span>▸</span><span>${esc(dnt.name)}</span>${dnt.isRepo ? '<span class="repo-badge">GIT</span>' : ""}`);
      it.onclick = () => load(dnt.path);
      list.append(it);
    }
  }
  load(startPath);
}

function cloneDialog() {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">URL</label>
      <input class="dlg-input" id="cl-url" placeholder="https://github.com/user/repo.git"></div>
    <div class="dlg-row"><label class="lbl">Directory</label>
      <input class="dlg-input" id="cl-dir" placeholder="parent directory, e.g. ~/projects"></div>
    <div class="dlg-error hidden" id="cl-err"></div>`;
  dialog({
    title: "Get from Version Control",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Clone", primary: true, keep: true, onClick: async (d) => {
          const url = $("#cl-url", body).value.trim();
          const parent = $("#cl-dir", body).value.trim() || "~";
          if (!url) return;
          try {
            await post("action", { name: "clone", args: { url, parent } });
            const name = url.replace(/\/+$/, "").split("/").pop().replace(/\.git$/, "");
            d.close();
            openProject(parent.replace(/\/+$/, "") + "/" + name);
          } catch (e) {
            const eb = $("#cl-err", body);
            eb.classList.remove("hidden");
            eb.textContent = e.message;
          }
        } },
    ],
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Dialog & popup infrastructure
   ═══════════════════════════════════════════════════════════════════ */
function dialog({ title, body, buttons }) {
  const layer = $("#modal-layer");
  layer.innerHTML = "";
  const box = el("div", "dialog");
  box.append(el("div", "dlg-title", esc(title)));
  const b = el("div", "dlg-body");
  b.append(body);
  box.append(b);
  const foot = el("div", "dlg-footer");
  const handle = { close: () => { layer.classList.remove("open"); layer.innerHTML = ""; } };
  for (const btn of buttons) {
    const bn = el("button", "btn" + (btn.primary ? " primary" : "") + (btn.danger ? " danger" : ""), esc(btn.label));
    if (btn.left) bn.classList.add("left");
    bn.onclick = async () => {
      if (btn.onClick) await btn.onClick(handle, bn);
      if (!btn.keep) handle.close();
    };
    foot.append(bn);
  }
  box.append(foot);
  layer.append(box);
  layer.classList.add("open");
  layer.onmousedown = e => { if (e.target === layer) handle.close(); };
  const first = $("input,select,textarea", body);
  if (first) setTimeout(() => first.focus(), 30);
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
      const prim = $(".btn.primary", foot);
      if (prim) { e.preventDefault(); prim.click(); }
    }
  });
  return handle;
}

function confirmDialog(title, msg, okLabel = "OK", danger = false) {
  return new Promise(resolve => {
    const body = el("div", "", `<div style="white-space:pre-wrap">${esc(msg)}</div>`);
    dialog({
      title, body,
      buttons: [
        { label: "Cancel", onClick: () => resolve(false) },
        { label: okLabel, primary: !danger, danger, onClick: () => resolve(true) },
      ],
    });
  });
}

/* Popups (branch widget, context menus). Closes on outside click / Esc. */
function popup(anchorOrPoint, build) {
  const layer = $("#popup-layer");
  layer.innerHTML = "";
  layer.classList.add("open");
  const p = el("div", "popup");
  build(p, close);
  layer.append(p);
  // position
  let x, y;
  if (anchorOrPoint instanceof Element) {
    const r = anchorOrPoint.getBoundingClientRect();
    x = r.left; y = r.bottom + 4;
  } else {
    x = anchorOrPoint.x; y = anchorOrPoint.y;
  }
  const vw = innerWidth, vh = innerHeight;
  p.style.left = Math.min(x, vw - p.offsetWidth - 8) + "px";
  p.style.top = Math.min(y, vh - p.offsetHeight - 8) + "px";
  function close() { layer.classList.remove("open"); layer.innerHTML = ""; }
  layer.onmousedown = e => { if (e.target === layer) close(); };
  return close;
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    $("#popup-layer").classList.remove("open");
    $("#modal-layer").classList.remove("open");
  }
});
const mi = (html, cls = "") => el("div", "popup-item " + cls, html);

/* ═══════════════════════════════════════════════════════════════════
   Toolbar, summary, polling
   ═══════════════════════════════════════════════════════════════════ */
function wireChrome() {
  $("#btn-branch").onclick = e => branchPopup(e.currentTarget);
  $("#sb-branch").onclick = e => branchPopup(e.currentTarget);
  $("#btn-project").onclick = e => projectPopup(e.currentTarget);
  $("#btn-hamburger").onclick = e => projectPopup($("#btn-project"));
  $("#btn-update").onclick = () => pullDialog();
  $("#btn-push").onclick = () => pushDialog();
  $("#btn-fetch").onclick = () => action("fetch", {}, "Fetched", "All remotes fetched and pruned");
  $("#btn-stash").onclick = () => stashDialog();
  $("#btn-commit-tw").onclick = () => { toggleCommitTW(true); $("#commit-msg").focus(); };
  $("#btn-console-tw").onclick = () => { toggleGitTW(true); switchTab("console"); };
  $("#rail-commit").onclick = () => toggleCommitTW();
  $("#rail-git").onclick = () => toggleGitTW();
  $("#ct-hide").onclick = () => toggleCommitTW(false);
  $("#gt-hide").onclick = () => toggleGitTW(false);
  $("#ct-refresh").onclick = () => refreshAll();
  $("#log-refresh").onclick = () => refreshAll();
  $("#ct-rollback").onclick = () => rollbackSelected();
  $("#btn-do-commit").onclick = () => doCommit(false);
  $("#btn-commit-push").onclick = () => doCommit(true);
  $("#ed-tab-close").onclick = () => closeDiff();
  $$(".tw-tab").forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $("#flt-search").oninput = debounce(() => { S.logFilter.search = $("#flt-search").value.trim(); loadLog(); }, 350);
  $("#flt-branch").onclick = e => branchFilterPopup(e.currentTarget);
  $("#flt-user").onclick = e => userFilterPopup(e.currentTarget);
  $("#conflict-resolve").onclick = e => { e.preventDefault(); conflictsDialog(); };
  $("#conflict-abort").onclick = e => { e.preventDefault(); abortOperation(); };
  $("#conflict-continue").onclick = e => { e.preventDefault(); continueOperation(); };
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k" && !e.shiftKey) { e.preventDefault(); toggleCommitTW(true); $("#commit-msg").focus(); }
    if (mod && e.key.toLowerCase() === "k" && e.shiftKey) { e.preventDefault(); pushDialog(); }
    if (mod && e.key === "9") { e.preventDefault(); toggleGitTW(); }
    if (mod && e.key === "0") { e.preventDefault(); toggleCommitTW(); }
    if (mod && e.key.toLowerCase() === "d" && S.selection) { e.preventDefault(); showWorkingDiff(S.selection); }
  });
}

function toggleCommitTW(force) {
  const tw = $("#commit-tw");
  const show = force !== undefined ? force : tw.classList.contains("hidden");
  tw.classList.toggle("hidden", !show);
  $("#rail-commit").classList.toggle("active", show);
}
function toggleGitTW(force) {
  const tw = $("#git-tw");
  const show = force !== undefined ? force : tw.classList.contains("hidden");
  tw.classList.toggle("hidden", !show);
  $("#rail-git").classList.toggle("active", show);
}
function switchTab(name) {
  $$(".tw-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $("#tab-log").classList.toggle("hidden", name !== "log");
  $("#tab-console").classList.toggle("hidden", name !== "console");
  if (name === "console") loadConsole();
}

async function refreshAll() {
  try {
    S.summary = await api("summary");
  } catch { return; }
  renderSummary();
  await Promise.all([loadStatus(), loadLog(), loadConsoleQuiet()]);
  S.branches = null; // invalidate cache; branch popup reloads lazily
}

function renderSummary() {
  const s = S.summary;
  document.title = `${s.name} – GitLoved`;
  $("#project-name").textContent = s.name;
  $("#project-avatar").textContent = s.name[0].toUpperCase();
  const label = s.branch || (s.detached ? `Detached: ${s.detached}` : "no branch");
  $("#branch-name").textContent = label;
  $("#sb-branch-name").textContent = label;
  $("#sb-path").textContent = s.path;
  const io = [];
  if (s.behind) io.push(`<b class="in">${s.behind} ↓</b>`);
  if (s.ahead) io.push(`<b class="out">${s.ahead} ↑</b>`);
  $("#branch-inout").innerHTML = io.join(" ");
  const badge = $("#op-badge");
  if (s.operation) {
    badge.textContent = s.operation + " in progress";
    badge.classList.remove("hidden");
  } else badge.classList.add("hidden");
}

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if ($("#modal-layer").classList.contains("open")) return;
    const before = JSON.stringify([S.summary, S.status]);
    try {
      S.summary = await api("summary");
      const st = await api("status");
      if (JSON.stringify([S.summary, st]) !== before) {
        S.status = st;
        renderSummary();
        renderChanges();
      }
    } catch { /* server gone */ }
  }, 4000);
}

/* ═══════════════════════════════════════════════════════════════════
   Project widget popup
   ═══════════════════════════════════════════════════════════════════ */
async function projectPopup(anchor) {
  const rec = await api("recent").catch(() => ({ recent: [] }));
  popup(anchor, (p, close) => {
    p.append(el("div", "popup-title", "Project"));
    const open = mi(`<span class="grow">Open…</span><span class="sub">browse</span>`);
    open.onclick = () => { close(); browseDialog(); };
    p.append(open);
    const clone = mi(`<span class="grow">Get from VCS…</span>`);
    clone.onclick = () => { close(); cloneDialog(); };
    p.append(clone);
    if (rec.recent.length) {
      p.append(el("div", "popup-section", "Recent projects"));
      const sc = el("div", "popup-scroll");
      for (const r of rec.recent) {
        const it = mi(`<span class="grow">${esc(r.name)}</span><span class="meta">${esc(r.path)}</span>`,
          r.exists ? "" : "disabled");
        it.onclick = () => { close(); openProject(r.path); };
        sc.append(it);
      }
      p.append(sc);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Branch popup — the heart of the plugin
   ═══════════════════════════════════════════════════════════════════ */
async function branchPopup(anchor) {
  if (!S.branches) S.branches = await api("branches").catch(() => null);
  const br = S.branches;
  if (!br) return;
  popup(anchor, (p, close) => {
    p.style.minWidth = "320px";
    p.append(el("div", "popup-title", `Git Branches in ${esc(S.summary.name)}`));
    const search = el("input", "popup-search");
    search.placeholder = "Search branches";
    p.append(search);

    const nb = mi(`<span style="color:var(--link)">+</span><span class="grow">New Branch…</span>`);
    nb.onclick = () => { close(); newBranchDialog(); };
    p.append(nb);
    const co = mi(`<span>⎇</span><span class="grow">Checkout Tag or Revision…</span>`);
    co.onclick = () => { close(); checkoutRevisionDialog(); };
    p.append(co);
    p.append(el("div", "popup-sep"));

    const scroll = el("div", "popup-scroll");
    p.append(scroll);

    function render(filter = "") {
      scroll.innerHTML = "";
      const f = filter.toLowerCase();
      const locals = br.local.filter(b => b.name.toLowerCase().includes(f));
      const remotes = br.remote.filter(b => b.name.toLowerCase().includes(f));
      if (locals.length) scroll.append(el("div", "popup-section", "Local"));
      for (const b of locals) {
        const io = [];
        if (b.behind) io.push(`<b class="in">${b.behind}↓</b>`);
        if (b.ahead) io.push(`<b class="out">${b.ahead}↑</b>`);
        const it = mi(
          `<span class="mark">${b.current ? "●" : ""}</span>
           ${BRANCH_SVG}
           <span class="grow">${esc(b.name)}</span>
           <span class="io">${io.join(" ")}</span>
           <span class="meta">${b.upstream ? esc(b.upstream) + (b.gone ? " (gone)" : "") : ""}</span>`);
        it.onclick = e => branchActions(b, { x: e.clientX, y: e.clientY }, close);
        scroll.append(it);
      }
      if (remotes.length) scroll.append(el("div", "popup-section", "Remote"));
      for (const b of remotes) {
        const it = mi(`<span class="mark"></span>${BRANCH_SVG}<span class="grow">${esc(b.name)}</span>`);
        it.onclick = e => remoteBranchActions(b, { x: e.clientX, y: e.clientY }, close);
        scroll.append(it);
      }
      if (br.stashes.length && !f) {
        scroll.append(el("div", "popup-section", "Stashes"));
        for (const st of br.stashes) {
          const it = mi(`<span class="mark"></span><span>🗃</span><span class="grow">${esc(st.message)}</span><span class="meta">${esc(st.ref)}</span>`);
          it.onclick = e => stashActions(st, { x: e.clientX, y: e.clientY }, close);
          scroll.append(it);
        }
      }
      if (!locals.length && !remotes.length)
        scroll.append(el("div", "popup-item disabled", "Nothing found"));
    }
    render();
    search.oninput = () => render(search.value.trim());
    setTimeout(() => search.focus(), 30);
  });
}

function branchActions(b, pt, closeParent) {
  const cur = S.summary.branch;
  popup(pt, (p, close) => {
    p.append(el("div", "popup-title", esc(b.name)));
    const add = (label, fn, cls = "") => {
      const it = mi(`<span class="grow">${label}</span>`, cls);
      it.onclick = async () => { close(); closeParent(); await fn(); };
      p.append(it);
    };
    if (!b.current) {
      add("Checkout", () => action("checkout", { branch: b.name }, `Checked out ${b.name}`));
      p.append(el("div", "popup-sep"));
    }
    add(`New Branch from ‘${esc(b.name)}’…`, () => newBranchDialog(b.name));
    if (!b.current && cur) {
      p.append(el("div", "popup-sep"));
      add(`Merge ‘${esc(b.name)}’ into ‘${esc(cur)}’`, () => mergeDialog(b.name));
      add(`Rebase ‘${esc(cur)}’ onto ‘${esc(b.name)}’`, () =>
        confirmDialog("Rebase", `Rebase ‘${cur}’ onto ‘${b.name}’?`, "Rebase")
          .then(ok => ok && action("rebase", { onto: b.name }, `Rebased ${cur} onto ${b.name}`)));
    }
    if (b.upstream && b.current) {
      p.append(el("div", "popup-sep"));
      add(`Pull from ‘${esc(b.upstream)}’`, () => pullDialog());
      add(`Push to ‘${esc(b.upstream)}’…`, () => pushDialog());
    }
    p.append(el("div", "popup-sep"));
    add("Rename…", () => renameBranchDialog(b.name));
    if (!b.current)
      add("Delete", () => deleteBranchFlow(b.name), "");
  });
}

function remoteBranchActions(b, pt, closeParent) {
  const cur = S.summary.branch;
  popup(pt, (p, close) => {
    p.append(el("div", "popup-title", esc(b.name)));
    const add = (label, fn) => {
      const it = mi(`<span class="grow">${label}</span>`);
      it.onclick = async () => { close(); closeParent(); await fn(); };
      p.append(it);
    };
    add("Checkout", async () => {
      const local = b.name.split("/").slice(1).join("/");
      await action("checkout_remote", { branch: b.name, as: local },
        `Checked out ${local}`, `Tracking ${b.name}`);
    });
    add(`New Branch from ‘${esc(b.name)}’…`, () => newBranchDialog(b.name));
    if (cur) {
      p.append(el("div", "popup-sep"));
      add(`Merge ‘${esc(b.name)}’ into ‘${esc(cur)}’`, () => mergeDialog(b.name));
      add(`Rebase ‘${esc(cur)}’ onto ‘${esc(b.name)}’`, () =>
        confirmDialog("Rebase", `Rebase ‘${cur}’ onto ‘${b.name}’?`, "Rebase")
          .then(ok => ok && action("rebase", { onto: b.name }, `Rebased onto ${b.name}`)));
    }
    p.append(el("div", "popup-sep"));
    add("Delete on Remote…", () =>
      confirmDialog("Delete remote branch", `Delete ‘${b.name}’ on the remote?\nThis cannot be undone locally.`, "Delete", true)
        .then(ok => ok && action("delete_remote_branch", { branch: b.name }, `Deleted ${b.name}`)));
  });
}

function stashActions(st, pt, closeParent) {
  popup(pt, (p, close) => {
    p.append(el("div", "popup-title", esc(st.ref)));
    const add = (label, fn) => {
      const it = mi(`<span class="grow">${label}</span>`);
      it.onclick = async () => { close(); closeParent(); await fn(); };
      p.append(it);
    };
    add("Pop (apply and drop)", () => action("unstash", { ref: st.ref, pop: true }, "Unstashed", st.message));
    add("Apply (keep stash)", () => action("unstash", { ref: st.ref, pop: false }, "Applied stash", st.message));
    p.append(el("div", "popup-sep"));
    add("Drop", () =>
      confirmDialog("Drop stash", `Drop ‘${st.message}’?`, "Drop", true)
        .then(ok => ok && action("drop_stash", { ref: st.ref }, "Stash dropped")));
  });
}

async function deleteBranchFlow(name) {
  try {
    await post("action", { name: "delete_branch", args: { branch: name } });
    balloon("ok", `Deleted branch ${name}`);
    refreshAll();
  } catch (e) {
    if (/not fully merged/i.test(e.message)) {
      const ok = await confirmDialog("Branch not fully merged",
        `‘${name}’ contains commits that are not merged.\nDelete anyway?`, "Force Delete", true);
      if (ok) action("delete_branch", { branch: name, force: true }, `Deleted branch ${name}`);
    } else balloon("err", "Delete failed", e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Git dialogs
   ═══════════════════════════════════════════════════════════════════ */
function newBranchDialog(from) {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">Name</label>
      <input class="dlg-input" id="nb-name" placeholder="feature/awesome"></div>
    ${from ? `<div class="dlg-note">Starting point: <b>${esc(from)}</b></div>` : ""}
    <label class="cb"><input type="checkbox" id="nb-checkout" checked> Checkout branch</label>
    <div class="dlg-error hidden" id="nb-err"></div>`;
  dialog({
    title: "New Branch",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Create", primary: true, keep: true, onClick: async d => {
          const name = $("#nb-name", body).value.trim();
          if (!name) return;
          try {
            await post("action", { name: "new_branch",
              args: { name, from, checkout: $("#nb-checkout", body).checked } });
            d.close();
            balloon("ok", `Branch ${name} created`);
            refreshAll();
          } catch (e) { showErr(body, "#nb-err", e); }
        } },
    ],
  });
}

function renameBranchDialog(old) {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">New name</label>
      <input class="dlg-input" id="rn-name" value="${esc(old)}"></div>
    <div class="dlg-error hidden" id="rn-err"></div>`;
  dialog({
    title: `Rename Branch ‘${old}’`,
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Rename", primary: true, keep: true, onClick: async d => {
          const nw = $("#rn-name", body).value.trim();
          if (!nw || nw === old) return d.close();
          try {
            await post("action", { name: "rename_branch", args: { old, new: nw } });
            d.close(); balloon("ok", `Renamed to ${nw}`); refreshAll();
          } catch (e) { showErr(body, "#rn-err", e); }
        } },
    ],
  });
}

function mergeDialog(branch) {
  const cur = S.summary.branch;
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-note">Merge <b>${esc(branch)}</b> into <b>${esc(cur)}</b></div>
    <label class="cb"><input type="checkbox" id="mg-noff"> --no-ff (always create a merge commit)</label>
    <label class="cb"><input type="checkbox" id="mg-squash"> --squash</label>
    <div class="dlg-error hidden" id="mg-err"></div>`;
  dialog({
    title: "Merge Branches",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Merge", primary: true, keep: true, onClick: async d => {
          try {
            const res = await post("action", { name: "merge",
              args: { branch, noFf: $("#mg-noff", body).checked, squash: $("#mg-squash", body).checked } });
            d.close(); balloon("ok", `Merged ${branch}`, res.output.trim().split("\n").slice(-2).join("\n"));
            refreshAll();
          } catch (e) {
            d.close();
            await refreshAll();
            if (S.status.conflicts.length) conflictsDialog();
            else balloon("err", "Merge failed", e.message);
          }
        } },
    ],
  });
}

function checkoutRevisionDialog() {
  const tags = (S.branches && S.branches.tags) || [];
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">Revision</label>
      <input class="dlg-input" id="cr-rev" list="cr-tags" placeholder="tag, branch or commit hash"></div>
    <datalist id="cr-tags">${tags.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
    <div class="dlg-note">Checking out a revision detaches HEAD.</div>
    <div class="dlg-error hidden" id="cr-err"></div>`;
  dialog({
    title: "Checkout Tag or Revision",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Checkout", primary: true, keep: true, onClick: async d => {
          const rev = $("#cr-rev", body).value.trim();
          if (!rev) return;
          try {
            await post("action", { name: "checkout_revision", args: { rev } });
            d.close(); balloon("ok", `Checked out ${rev}`); refreshAll();
          } catch (e) { showErr(body, "#cr-err", e); }
        } },
    ],
  });
}

function pullDialog() {
  const s = S.summary;
  const remotes = s.remotes.length ? s.remotes : ["origin"];
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">Remote</label>
      <select class="dlg-select" id="pl-remote">${remotes.map(r => `<option>${esc(r)}</option>`).join("")}</select></div>
    <div class="dlg-row"><label class="lbl">Branch</label>
      <input class="dlg-input" id="pl-branch" value="${esc(s.branch || "")}"></div>
    <div class="radio-row">
      <label><input type="radio" name="pl-mode" id="pl-merge" checked> Merge incoming changes</label>
      <label><input type="radio" name="pl-mode" id="pl-rebase"> Rebase onto incoming</label>
    </div>
    <label class="cb"><input type="checkbox" id="pl-ff"> --ff-only</label>
    <label class="cb"><input type="checkbox" id="pl-prune"> --prune</label>
    <div class="dlg-error hidden" id="pl-err"></div>`;
  dialog({
    title: "Update Project (Pull)",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Pull", primary: true, keep: true, onClick: async d => {
          try {
            const res = await post("action", { name: "pull", args: {
              remote: $("#pl-remote", body).value,
              branch: $("#pl-branch", body).value.trim(),
              rebase: $("#pl-rebase", body).checked,
              ffOnly: $("#pl-ff", body).checked,
              prune: $("#pl-prune", body).checked,
            } });
            d.close();
            balloon("ok", "Update finished", res.output.trim().split("\n").slice(-3).join("\n"));
            refreshAll();
          } catch (e) {
            d.close();
            await refreshAll();
            if (S.status.conflicts.length) conflictsDialog();
            else balloon("err", "Update failed", e.message);
          }
        } },
    ],
  });
}

async function pushDialog() {
  const s = S.summary;
  if (!s.branch) return balloon("err", "Cannot push", "HEAD is detached — checkout a branch first.");
  const remote = (s.upstream || "origin/").split("/")[0] || "origin";
  const target = s.upstream || `${remote}/${s.branch}`;
  let commits = [];
  try {
    const range = s.upstream ? `${s.upstream}..HEAD` : "HEAD";
    commits = (await api("log", { branch: range, limit: 100 })).commits;
  } catch { /* fine */ }
  const body = el("div");
  body.innerHTML = `
    <div class="push-commits">
      <div class="push-branch-line">${esc(s.branch)} <span class="arrow">→</span> ${esc(target)}
        ${s.upstream ? "" : ' <span class="arrow">(new upstream)</span>'}</div>
      ${commits.length ? commits.map(c => `
        <div class="push-commit"><span class="h">${esc(c.short)}</span>
          <span class="s">${esc(c.subject)}</span><span class="a">${esc(c.author)}</span></div>`).join("")
        : `<div class="push-empty">Everything is up to date — nothing to push</div>`}
    </div>
    <label class="cb"><input type="checkbox" id="ps-tags"> Push tags</label>
    <div class="dlg-error hidden" id="ps-err"></div>`;
  dialog({
    title: `Push Commits to ${target}`,
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Force Push", danger: true, keep: true, onClick: async d => {
          const ok = await confirmDialog("Force push",
            `Force-push ‘${s.branch}’ to ${target}?\nUses --force-with-lease.`, "Force Push", true);
          if (ok) runPush(d, body, true);
        } },
      { label: "Push", primary: true, keep: true, onClick: (d) => runPush(d, body, false) },
    ],
  });
  async function runPush(d, body, force) {
    try {
      const res = await post("action", { name: "push", args: {
        remote, refspec: s.branch, setUpstream: !s.upstream,
        tags: $("#ps-tags", body).checked, forceWithLease: force,
      } });
      d.close();
      const n = commits.length;
      balloon("ok", n ? `Pushed ${n} commit${n === 1 ? "" : "s"} to ${target}` : `Pushed to ${target}`,
        res.output.trim().split("\n").slice(-2).join("\n"));
      refreshAll();
    } catch (e) { showErr(body, "#ps-err", e); }
  }
}

function stashDialog() {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">Message</label>
      <input class="dlg-input" id="st-msg" placeholder="optional"></div>
    <label class="cb"><input type="checkbox" id="st-untracked" checked> Include untracked files</label>
    <label class="cb"><input type="checkbox" id="st-keep"> Keep index (--keep-index)</label>
    <div class="dlg-error hidden" id="st-err"></div>`;
  dialog({
    title: "Stash Changes",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Stash", primary: true, keep: true, onClick: async d => {
          try {
            await post("action", { name: "stash", args: {
              message: $("#st-msg", body).value.trim(),
              includeUntracked: $("#st-untracked", body).checked,
              keepIndex: $("#st-keep", body).checked } });
            d.close(); balloon("ok", "Changes stashed"); refreshAll();
          } catch (e) { showErr(body, "#st-err", e); }
        } },
    ],
  });
}

function resetDialog(hash, subject) {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-note">Reset <b>${esc(S.summary.branch || "HEAD")}</b> to
      <b class="hash">${esc(hash.slice(0, 8))}</b> “${esc(subject)}”</div>
    <div class="radio-row" style="flex-direction:column;gap:8px">
      <label><input type="radio" name="rs" value="soft"> Soft <span class="dim">— keep changes staged</span></label>
      <label><input type="radio" name="rs" value="mixed" checked> Mixed <span class="dim">— keep changes unstaged</span></label>
      <label><input type="radio" name="rs" value="hard"> Hard <span class="dim">— discard all changes</span></label>
      <label><input type="radio" name="rs" value="keep"> Keep <span class="dim">— like hard, but keeps local changes</span></label>
    </div>
    <div class="dlg-error hidden" id="rs-err"></div>`;
  dialog({
    title: "Reset Current Branch to Here",
    body,
    buttons: [
      { label: "Cancel" },
      { label: "Reset", primary: true, keep: true, onClick: async d => {
          const mode = $("input[name=rs]:checked", body).value;
          if (mode === "hard") {
            const ok = await confirmDialog("Hard reset",
              "All uncommitted changes will be lost. Continue?", "Reset", true);
            if (!ok) return;
          }
          try {
            await post("action", { name: "reset", args: { mode, to: hash } });
            d.close(); balloon("ok", `Reset (--${mode}) to ${hash.slice(0, 8)}`); refreshAll();
          } catch (e) { showErr(body, "#rs-err", e); }
        } },
    ],
  });
}

function conflictsDialog() {
  const files = S.status.conflicts;
  if (!files.length) return;
  const op = S.summary.operation || "merge";
  const body = el("div");
  const list = el("div", "conflict-list");
  for (const f of files) {
    const row = el("div", "conflict-file",
      `<span class="p">${esc(f.path)}</span>
       <button class="btn mini" data-side="ours">Accept Yours</button>
       <button class="btn mini" data-side="theirs">Accept Theirs</button>`);
    $$("button", row).forEach(b => b.onclick = async () => {
      await action("resolve", { side: b.dataset.side, files: [f.path] },
        "Resolved", `${f.path} → ${b.dataset.side}`);
      row.remove();
      if (!$(".conflict-file", list)) $("#modal-layer").classList.remove("open");
    });
    list.append(row);
  }
  body.append(el("div", "dlg-note",
    `Conflicts during <b>${esc(op)}</b>. Resolve each file, then continue the operation.`));
  body.append(list);
  dialog({
    title: `${files.length} File${files.length > 1 ? "s" : ""} Merged with Conflicts`,
    body,
    buttons: [
      { label: `Abort ${titleCase(op)}`, danger: true, onClick: () => abortOperation() },
      { label: "Close" },
      { label: `Continue ${titleCase(op)}`, primary: true, onClick: () => continueOperation() },
    ],
  });
}

async function abortOperation() {
  const op = S.summary.operation;
  if (!op) return;
  const ok = await confirmDialog(`Abort ${op}`, `Abort the ${op} in progress?`, "Abort", true);
  if (ok) action("abort", { op }, `${titleCase(op)} aborted`);
}
async function continueOperation() {
  const op = S.summary.operation;
  if (!op) return;
  action("continue", { op }, `${titleCase(op)} continued`);
}

function showErr(body, sel, e) {
  const eb = $(sel, body);
  if (!eb) return balloon("err", "Error", e.message);
  eb.classList.remove("hidden");
  eb.textContent = e.message;
}

/* ═══════════════════════════════════════════════════════════════════
   Commit tool window
   ═══════════════════════════════════════════════════════════════════ */
async function loadStatus() {
  S.status = await api("status").catch(() => S.status);
  // keep checkbox state for files that still exist; auto-check newly seen ones
  const all = [...S.status.changes, ...S.status.conflicts];
  const paths = new Set(all.map(f => f.path));
  if (!S.checkedInitialized) {
    S.checked = new Set(all.map(f => f.path));
    S.checkedInitialized = true;
  } else {
    for (const p of [...S.checked])
      if (!paths.has(p) && !S.status.unversioned.some(u => u.path === p)) S.checked.delete(p);
    for (const f of all) if (!S.everSeen?.has(f.path)) S.checked.add(f.path);
  }
  S.everSeen = S.everSeen || new Set();
  for (const f of all) S.everSeen.add(f.path);
  renderChanges();
}

function renderChanges() {
  const tree = $("#changes-tree");
  tree.innerHTML = "";
  const st = S.status;

  const banner = $("#conflict-banner");
  const op = S.summary?.operation;
  if (st.conflicts.length || op) {
    banner.classList.remove("hidden");
    $("#conflict-text").textContent = st.conflicts.length
      ? `${st.conflicts.length} merge conflict${st.conflicts.length > 1 ? "s" : ""}`
      : `${op} in progress`;
    $("#conflict-resolve").style.display = st.conflicts.length ? "" : "none";
  } else banner.classList.add("hidden");

  const group = (id, label, files, opts = {}) => {
    if (!files.length) return;
    const g = el("div", "tree-group" + (S.collapsed.has(id) ? " collapsed" : ""),
      `<span class="arrow">▾</span><span>${label}</span><span class="tw-count">${files.length} file${files.length > 1 ? "s" : ""}</span>`);
    g.onclick = () => {
      S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id);
      renderChanges();
    };
    tree.append(g);
    if (S.collapsed.has(id)) return;
    for (const f of files) tree.append(fileRow(f, opts));
  };
  group("conflicts", "Merge Conflicts", st.conflicts, { conflict: true });
  group("changes", "Changes", st.changes, {});
  group("unversioned", "Unversioned Files", st.unversioned, { unversioned: true });
  if (!st.changes.length && !st.unversioned.length && !st.conflicts.length)
    tree.append(el("div", "tree-file dim", `<span class="fname" style="color:var(--fg-faint)">No changes</span>`));
}

function fileRow(f, opts) {
  const parts = f.path.split("/");
  const name = parts.pop();
  const dir = parts.join("/");
  const row = el("div", `tree-file st-${f.kind}`);
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = S.checked.has(f.path);
  cb.onclick = e => {
    e.stopPropagation();
    cb.checked ? S.checked.add(f.path) : S.checked.delete(f.path);
  };
  row.append(cb);
  row.append(el("span", "fname", esc(name) + (f.orig ? ` <span class="fdir">← ${esc(f.orig)}</span>` : "")));
  if (dir) row.append(el("span", "fdir", esc(dir)));
  row.onclick = () => {
    $$(".tree-file.selected").forEach(r => r.classList.remove("selected"));
    row.classList.add("selected");
    S.selection = f;
    showWorkingDiff(f);
  };
  row.oncontextmenu = e => {
    e.preventDefault();
    fileContextMenu(f, { x: e.clientX, y: e.clientY });
  };
  return row;
}

function fileContextMenu(f, pt) {
  popup(pt, (p, close) => {
    const add = (label, fn, cls = "") => {
      const it = mi(`<span class="grow">${label}</span>`, cls);
      it.onclick = async () => { close(); await fn(); };
      p.append(it);
    };
    add("Show Diff", () => showWorkingDiff(f));
    p.append(el("div", "popup-sep"));
    if (f.kind === "untracked") {
      add("Add to VCS", () => action("add", { files: [f.path] }, `Added ${f.path}`));
      add("Delete…", () =>
        confirmDialog("Delete file", `Delete ‘${f.path}’ from disk?`, "Delete", true)
          .then(ok => ok && action("rollback", { untracked: [f.path] }, "Deleted", f.path)));
    } else if (f.kind === "conflict") {
      add("Accept Yours", () => action("resolve", { side: "ours", files: [f.path] }, "Resolved (yours)", f.path));
      add("Accept Theirs", () => action("resolve", { side: "theirs", files: [f.path] }, "Resolved (theirs)", f.path));
    } else {
      add("Rollback…", () =>
        confirmDialog("Rollback changes", `Discard local changes in ‘${f.path}’?`, "Rollback", true)
          .then(ok => ok && action("rollback", { tracked: [f.path] }, "Rolled back", f.path)));
    }
  });
}

async function rollbackSelected() {
  const tracked = S.status.changes.filter(f => S.checked.has(f.path)).map(f => f.path);
  const untracked = S.status.unversioned.filter(f => S.checked.has(f.path)).map(f => f.path);
  if (!tracked.length && !untracked.length)
    return balloon("info", "Nothing selected", "Tick the files you want to roll back.");
  const ok = await confirmDialog("Rollback",
    `Discard changes in ${tracked.length + untracked.length} file(s)?\nUntracked files will be deleted.`, "Rollback", true);
  if (ok) action("rollback", { tracked, untracked }, "Rolled back");
}

async function doCommit(push) {
  const msg = $("#commit-msg").value;
  const amend = $("#cb-amend").checked;
  const files = [
    ...S.status.changes, ...S.status.unversioned, ...S.status.conflicts,
  ].filter(f => S.checked.has(f.path)).map(f => f.path);
  if (!files.length && !amend)
    return balloon("info", "No files selected", "Tick the changes you want to commit.");
  if (!msg.trim() && !amend)
    return balloon("info", "Commit message is empty", "Enter a message in the Commit field.");
  try {
    const res = await post("action", { name: "commit",
      args: { message: msg, files, amend, push,
              pushArgs: { remote: (S.summary.upstream || "origin/").split("/")[0] || "origin",
                          refspec: S.summary.branch, setUpstream: !S.summary.upstream } } });
    $("#commit-msg").value = "";
    $("#cb-amend").checked = false;
    const n = files.length;
    balloon("ok", push ? `Committed and pushed ${n} file${n === 1 ? "" : "s"}`
                       : `${n} file${n === 1 ? "" : "s"} committed`,
      msg.trim().split("\n")[0]);
    refreshAll();
  } catch (e) {
    balloon("err", "Commit failed", e.message);
    refreshAll();
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Diff viewer (side-by-side, JetBrains colors)
   ═══════════════════════════════════════════════════════════════════ */
function closeDiff() {
  $("#editor-tabs").classList.add("hidden");
  $("#diff-root").classList.add("hidden");
  $("#editor-empty").classList.remove("hidden");
}

async function showWorkingDiff(f) {
  try {
    const { diff } = await api("diff", { path: f.path, kind: f.kind });
    openDiff(f.path, f.kind === "untracked" ? "unversioned" : "working tree vs HEAD", diff);
  } catch (e) { balloon("err", "Diff failed", e.message); }
}
async function showCommitDiff(hash, path) {
  try {
    const { diff } = await api("diff_commit", { hash, path });
    openDiff(path, `at ${hash.slice(0, 8)}`, diff);
  } catch (e) { balloon("err", "Diff failed", e.message); }
}

function openDiff(path, meta, text) {
  $("#editor-tabs").classList.remove("hidden");
  $("#editor-empty").classList.add("hidden");
  const root = $("#diff-root");
  root.classList.remove("hidden");
  $("#ed-tab-name").textContent = path.split("/").pop();
  $("#ed-tab-meta").textContent = `${path} — ${meta}`;
  root.innerHTML = "";
  if (!text.trim()) {
    root.append(el("div", "empty-inner dim", "No textual changes (identical, binary, or mode-only change)."));
    return;
  }
  const lines = text.split("\n");
  let i = 0, lNum = 0, rNum = 0;
  const frag = document.createDocumentFragment();
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(ln);
      if (m) { lNum = +m[1]; rNum = +m[2]; }
      frag.append(el("div", "diff-hunk-sep", esc(ln)));
      i++;
      continue;
    }
    if (ln.startsWith("-") && !ln.startsWith("---")) {
      const dels = [], adds = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) dels.push(lines[i++].slice(1));
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) adds.push(lines[i++].slice(1));
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const hasL = k < dels.length, hasR = k < adds.length;
        let lHtml = hasL ? esc(dels[k]) : "";
        let rHtml = hasR ? esc(adds[k]) : "";
        let cls = hasL && hasR ? "chg" : "";
        if (hasL && hasR) [lHtml, rHtml] = wordDiff(dels[k], adds[k]);
        frag.append(diffRow(
          hasL ? lNum++ : "", lHtml, hasL ? (cls || "del") : "pad",
          hasR ? rNum++ : "", rHtml, hasR ? (cls || "add") : "pad"));
      }
      continue;
    }
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      frag.append(diffRow("", "", "pad", rNum++, esc(ln.slice(1)), "add"));
      i++;
      continue;
    }
    if (ln.startsWith(" ") || ln === "") {
      if (i === lines.length - 1 && ln === "") break;
      frag.append(diffRow(lNum++, esc(ln.slice(1)), "", rNum++, esc(ln.slice(1)), ""));
      i++;
      continue;
    }
    i++; // headers: diff --git, index, ---, +++
  }
  root.append(frag);
}

function diffRow(ln, lHtml, lCls, rn, rHtml, rCls) {
  return el("div", "diff-row",
    `<div class="diff-side left ${lCls}"><span class="diff-num">${ln}</span><span class="diff-code">${lHtml || "&nbsp;"}</span></div>
     <div class="diff-side right ${rCls}"><span class="diff-num">${rn}</span><span class="diff-code">${rHtml || "&nbsp;"}</span></div>`);
}

function wordDiff(a, b) {
  let p = 0;
  const min = Math.min(a.length, b.length);
  while (p < min && a[p] === b[p]) p++;
  let sA = a.length, sB = b.length;
  while (sA > p && sB > p && a[sA - 1] === b[sB - 1]) { sA--; sB--; }
  const mk = (s, from, to, cls) =>
    esc(s.slice(0, from)) + (to > from ? `<span class="${cls}">${esc(s.slice(from, to))}</span>` : "") + esc(s.slice(to));
  return [mk(a, p, sA, "w-del"), mk(b, p, sB, "w-add")];
}

/* ═══════════════════════════════════════════════════════════════════
   Log: commit graph + table + details
   ═══════════════════════════════════════════════════════════════════ */
const LANE_COLORS = ["#3574F0", "#D26A5C", "#6AAB73", "#B07FD8",
                     "#D6AE58", "#4CA6A6", "#C575C1", "#8F9DEB"];
const ROW_H = 26, LANE_W = 12, LANE_PAD = 8;

async function loadLog() {
  const f = S.logFilter;
  try {
    S.log = await api("log", { limit: 400, search: f.search, branch: f.branch, author: f.author });
  } catch (e) {
    $("#log-body").innerHTML = `<tr><td colspan="5" class="dim" style="padding:10px">${esc(e.message)}</td></tr>`;
    return;
  }
  renderLog();
}

function computeGraph(commits) {
  let lanes = [];
  const rows = [];
  const firstFree = (skip = -1) => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] == null && i !== skip) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    const before = lanes.slice();
    const waiting = [];
    lanes.forEach((h, i) => { if (h === c.hash) waiting.push(i); });
    const lane = waiting.length ? waiting[0] : firstFree();
    const mergesIn = waiting.slice(1);
    const out = [];
    if (!c.parents.length) {
      lanes[lane] = null;
    } else {
      lanes[lane] = c.parents[0];
      out.push({ from: lane, to: lane });
      for (let pi = 1; pi < c.parents.length; pi++) {
        const p = c.parents[pi];
        let j = lanes.indexOf(p);
        if (j === -1) { j = firstFree(lane); lanes[j] = p; }
        out.push({ from: lane, to: j });
      }
    }
    for (const i of mergesIn) lanes[i] = null;
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    rows.push({ lane, before, after: lanes.slice(), mergesIn, out });
  }
  return rows;
}

function graphSvg(row) {
  const { lane, before, after, mergesIn, out } = row;
  const width = Math.max(before.length, after.length, lane + 1) * LANE_W + LANE_PAD;
  const x = i => i * LANE_W + LANE_PAD;
  const mid = ROW_H / 2;
  const col = i => LANE_COLORS[i % LANE_COLORS.length];
  let s = "";
  // top half: pass-throughs + converging children
  before.forEach((h, i) => {
    if (h == null) return;
    if (i === lane || mergesIn.includes(i)) {
      s += i === lane
        ? `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${mid}" stroke="${col(i)}" stroke-width="2"/>`
        : `<path d="M ${x(i)} 0 C ${x(i)} ${mid * .8}, ${x(lane)} ${mid * .3}, ${x(lane)} ${mid}" fill="none" stroke="${col(i)}" stroke-width="2"/>`;
    } else if (after[i] === h) {
      s += `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${mid}" stroke="${col(i)}" stroke-width="2"/>`;
    }
  });
  // bottom half: pass-throughs
  after.forEach((h, i) => {
    if (h == null || i === lane) return;
    if (before[i] === h)
      s += `<line x1="${x(i)}" y1="${mid}" x2="${x(i)}" y2="${ROW_H}" stroke="${col(i)}" stroke-width="2"/>`;
  });
  // bottom half: commit → parents
  for (const e of out) {
    s += e.from === e.to
      ? `<line x1="${x(e.from)}" y1="${mid}" x2="${x(e.from)}" y2="${ROW_H}" stroke="${col(e.from)}" stroke-width="2"/>`
      : `<path d="M ${x(e.from)} ${mid} C ${x(e.to)} ${mid * 1.2}, ${x(e.to)} ${mid * 1.7}, ${x(e.to)} ${ROW_H}" fill="none" stroke="${col(e.to)}" stroke-width="2"/>`;
  }
  s += `<circle cx="${x(lane)}" cy="${mid}" r="3.6" fill="${col(lane)}" stroke="var(--bg-editor)" stroke-width="1.5"/>`;
  return { svg: `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">${s}</svg>`, width };
}

function renderLog() {
  const body = $("#log-body");
  body.innerHTML = "";
  const commits = S.log.commits;
  $("#log-count").textContent = commits.length ? `${commits.length} commits` : "no commits";
  const rows = computeGraph(commits);
  let maxW = 60;
  const frag = document.createDocumentFragment();
  commits.forEach((c, idx) => {
    const g = graphSvg(rows[idx]);
    maxW = Math.max(maxW, g.width);
    const tr = el("tr", c.head ? "head-row" : "");
    tr.dataset.hash = c.hash;
    const chips = c.refs.map(r => {
      const cls = r.type === "tag" ? "tag" : r.type === "remote" ? "remote" : "local";
      return `<span class="ref-chip ${cls}">${r.type === "tag" ? "⌂" : ""}${esc(r.name)}</span>`;
    }).join("");
    const headChip = c.head && !c.refs.some(r => r.type === "local") ? `<span class="ref-chip headc">HEAD</span>` : "";
    tr.innerHTML = `
      <td class="graph">${g.svg}</td>
      <td class="desc">${headChip}${chips}<span class="subject">${esc(c.subject)}</span></td>
      <td class="author">${esc(c.author)}</td>
      <td class="date">${fmtDate(c.date)}</td>
      <td class="hash">${esc(c.short)}</td>`;
    tr.onclick = () => selectCommit(c.hash, tr);
    tr.oncontextmenu = e => {
      e.preventDefault();
      selectCommit(c.hash, tr);
      commitContextMenu(c, { x: e.clientX, y: e.clientY });
    };
    frag.append(tr);
  });
  body.append(frag);
  $("#log-table col.c-graph").style.width = Math.min(maxW + 6, 170) + "px";
  if (S.selectedCommit) {
    const tr = $(`#log-body tr[data-hash="${S.selectedCommit}"]`);
    if (tr) tr.classList.add("selected");
    else { S.selectedCommit = null; $("#commit-pane").innerHTML = `<div class="empty dim">Select a commit to see details</div>`; }
  }
}

async function selectCommit(hash, tr) {
  $$("#log-body tr.selected").forEach(r => r.classList.remove("selected"));
  tr.classList.add("selected");
  S.selectedCommit = hash;
  const pane = $("#commit-pane");
  pane.innerHTML = `<div class="empty dim">Loading…</div>`;
  try {
    const d = await api("commit", { hash });
    pane.innerHTML = `
      <div class="cp-subject">${esc(d.subject)}</div>
      ${d.body ? `<div class="cp-body">${esc(d.body)}</div>` : ""}
      <div class="cp-meta">
        <span class="hash" title="Copy full hash">${esc(d.hash.slice(0, 12))} ⧉</span><br>
        ${esc(d.author)} &lt;${esc(d.email)}&gt;<br>
        ${fmtDate(d.authorDate)}${d.parents.length > 1 ? `<br>Merge of ${d.parents.length} parents` : ""}
      </div>
      <div class="cp-files-title">${d.files.length} changed file${d.files.length === 1 ? "" : "s"}</div>`;
    $(".hash", pane).onclick = () => {
      navigator.clipboard?.writeText(d.hash);
      balloon("info", "Revision copied", d.hash, 2500);
    };
    for (const f of d.files) {
      const parts = f.path.split("/");
      const name = parts.pop();
      const row = el("div", `cp-file st-${f.status}`,
        `<span>${esc(name)}</span>${f.orig ? `<span class="fdir">← ${esc(f.orig)}</span>` : ""}
         ${parts.length ? `<span class="fdir">${esc(parts.join("/"))}</span>` : ""}`);
      row.onclick = () => showCommitDiff(hash, f.path);
      pane.append(row);
    }
  } catch (e) {
    pane.innerHTML = `<div class="empty dim">${esc(e.message)}</div>`;
  }
}

function commitContextMenu(c, pt) {
  popup(pt, (p, close) => {
    const add = (label, fn) => {
      const it = mi(`<span class="grow">${label}</span>`);
      it.onclick = async () => { close(); await fn(); };
      p.append(it);
    };
    add("Copy Revision Number", () => {
      navigator.clipboard?.writeText(c.hash);
      balloon("info", "Revision copied", c.hash, 2500);
    });
    p.append(el("div", "popup-sep"));
    add(`Checkout Revision ${c.short}`, () =>
      confirmDialog("Checkout revision", `Checkout ${c.short}? HEAD will be detached.`, "Checkout")
        .then(ok => ok && action("checkout_revision", { rev: c.hash }, `Checked out ${c.short}`)));
    add("New Branch from Here…", () => newBranchDialog(c.hash));
    add("New Tag…", () => tagDialog(c));
    p.append(el("div", "popup-sep"));
    add("Cherry-Pick", () => action("cherry_pick", { hash: c.hash }, `Cherry-picked ${c.short}`, c.subject));
    add("Revert Commit", () => action("revert_commit", { hash: c.hash }, `Reverted ${c.short}`, c.subject));
    p.append(el("div", "popup-sep"));
    add("Reset Current Branch to Here…", () => resetDialog(c.hash, c.subject));
  });
}

function tagDialog(c) {
  const body = el("div");
  body.innerHTML = `
    <div class="dlg-row"><label class="lbl">Tag name</label>
      <input class="dlg-input" id="tg-name" placeholder="v1.0.0"></div>
    <div class="dlg-note">On commit ${esc(c.short)} “${esc(c.subject)}”</div>
    <div class="dlg-error hidden" id="tg-err"></div>`;
  dialog({
    title: "New Tag", body,
    buttons: [
      { label: "Cancel" },
      { label: "Create Tag", primary: true, keep: true, onClick: async d => {
          const name = $("#tg-name", body).value.trim();
          if (!name) return;
          try {
            await post("action", { name: "tag", args: { name, on: c.hash } });
            d.close(); balloon("ok", `Tag ${name} created`); refreshAll();
          } catch (e) { showErr(body, "#tg-err", e); }
        } },
    ],
  });
}

/* filters */
async function branchFilterPopup(anchor) {
  if (!S.branches) S.branches = await api("branches").catch(() => null);
  popup(anchor, (p, close) => {
    const set = (label, value) => {
      const it = mi(`<span class="mark">${S.logFilter.branch === value ? "●" : ""}</span><span class="grow">${esc(label)}</span>`);
      it.onclick = () => {
        S.logFilter.branch = value;
        $("#flt-branch b").textContent = label;
        close(); loadLog();
      };
      p.append(it);
    };
    set("All", "");
    set("HEAD", "HEAD");
    p.append(el("div", "popup-sep"));
    const sc = el("div", "popup-scroll");
    for (const b of (S.branches?.local || [])) {
      const it = mi(`<span class="mark">${S.logFilter.branch === b.name ? "●" : ""}</span>${BRANCH_SVG}<span class="grow">${esc(b.name)}</span>`);
      it.onclick = () => {
        S.logFilter.branch = b.name;
        $("#flt-branch b").textContent = b.name;
        close(); loadLog();
      };
      sc.append(it);
    }
    p.append(sc);
  });
}

function userFilterPopup(anchor) {
  const users = [...new Set(S.log.commits.map(c => c.author))].sort();
  popup(anchor, (p, close) => {
    const set = (label, value) => {
      const it = mi(`<span class="mark">${S.logFilter.author === value ? "●" : ""}</span><span class="grow">${esc(label)}</span>`);
      it.onclick = () => {
        S.logFilter.author = value;
        $("#flt-user b").textContent = label;
        close(); loadLog();
      };
      p.append(it);
    };
    set("All", "");
    p.append(el("div", "popup-sep"));
    const sc = el("div", "popup-scroll");
    for (const u of users) {
      const it = mi(`<span class="mark">${S.logFilter.author === u ? "●" : ""}</span><span class="grow">${esc(u)}</span>`);
      it.onclick = () => {
        S.logFilter.author = u;
        $("#flt-user b").textContent = u;
        close(); loadLog();
      };
      sc.append(it);
    }
    p.append(sc);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Console
   ═══════════════════════════════════════════════════════════════════ */
async function loadConsole() {
  const { lines } = await api("console").catch(() => ({ lines: [] }));
  const out = $("#console-out");
  out.innerHTML = lines.map(l => `
    <div class="con-cmd"><span class="ts">${esc(l.ts)}:</span> ${esc(l.cmd)}</div>
    ${l.out ? `<div class="con-out${l.code ? " err" : ""}">${esc(l.out)}</div>` : `<div class="con-out"></div>`}`).join("");
  out.scrollTop = out.scrollHeight;
}
function loadConsoleQuiet() {
  if (!$("#tab-console").classList.contains("hidden")) return loadConsole();
}
