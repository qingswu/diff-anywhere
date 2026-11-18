import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { Autocomplete, invalidateListings } from "./autocomplete";
import { monaco, languageFor } from "./monaco";
import { buildMatcher, buildTree, esc, TreeView, type SearchOptions, type Entry, type Item, type Node, type Status } from "./tree";

// ---------- backend types ----------
type Outcome =
  | { kind: "dir"; left: string; right: string; items: Item[]; timings: { probe_ms: number; list_ms: number } }
  | { kind: "file"; left: string; right: string; left_entry: Entry | null; right_entry: Entry | null; binary: boolean };
interface FileSide { exists: boolean; binary: boolean; lossy: boolean; size: number; text: string; error: string | null }
interface FilePair { left: FileSide; right: FileSide }
type Side = "left" | "right";

// ---------- dom ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const leftIn = $<HTMLInputElement>("#left");
const rightIn = $<HTMLInputElement>("#right");
const filtersIn = $<HTMLInputElement>("#filters");
const compareBtn = $<HTMLButtonElement>("#compare");
const saveBtn = $<HTMLButtonElement>("#save");
const main = $("#main");
const errorBox = $("#error");
const editorHost = $("#editor-host");
const msgBox = $("#diff-message");
const diffHead = $("#diff-head");
const diffMeta = $("#diff-meta");
const counter = $("#change-counter");
const searchIn = $<HTMLInputElement>("#search");

// ---------- persisted prefs (best effort) ----------
const store = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem("da." + k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem("da." + k, JSON.stringify(v)); } catch { /* ignore */ }
  },
};
const prefs = store.get("prefs", { inline: false, whitespace: false, collapse: false, wrap: false });
type Method = "smart" | "content" | "quick";
let method: Method = store.get<Method>("method", "smart");
if (!["smart", "content", "quick"].includes(method)) method = "smart";
leftIn.value = store.get("left", "");
rightIn.value = store.get("right", "");
filtersIn.value = store.get("filters", ".git, node_modules, .DS_Store");
document.documentElement.style.setProperty("--sidebar-w", store.get("sidebarW", 340) + "px");

// Each side's own history first, then the other side's.
const recentFor = (own: string, other: string) => () =>
  [...new Set([...store.get<string[]>(own, []), ...store.get<string[]>(other, [])])];
// Must be created before the Enter-to-compare handlers below so it can claim keys first.
new Autocomplete(leftIn, recentFor("recentLeft", "recentRight"));
new Autocomplete(rightIn, recentFor("recentRight", "recentLeft"));
// Remember the last typed paths/filters even if no comparison ran.
for (const [el, key] of [[leftIn, "left"], [rightIn, "right"], [filtersIn, "filters"]] as const) {
  el.addEventListener("blur", () => store.set(key, el.value));
}

// ---------- session ----------
let session: {
  left: string;
  right: string;
  mode: "dir" | "file";
  root?: Node;
  items?: Item[];
  /** File mode only. */
  file?: { left: Entry | null; right: Entry | null; binary: boolean };
  /** Large text files the user chose not to load (show info only). */
  declined: Set<string>;
} | null = null;

/** Text files above this ask before loading the diff. */
const LARGE_TEXT = 4 << 20;
/** Matches the backend's read limit: above this, info only. */
const MAX_DIFF = 32 << 20;
let busy = false;
let loadToken = 0;
let compareGen = 0; // bumps on every compare; cancels background verification
let timingText = "";
let verifyState: { done: number; total: number } | null = null;

/** The file currently open in the diff editor. */
interface Doc {
  rel: string;
  title: string;
  item: Item | null;
  editable: Record<Side, boolean>;
  saved: Record<Side, number>; // model alternativeVersionId at last load/save
  exists: Record<Side, boolean>;
}
let doc: Doc | null = null;

const STATUS_LABEL: Record<Status, string> = {
  same: "Identical",
  changed: "Changed",
  left_only: "Left only",
  right_only: "Right only",
  pending: "Checking…",
};

// ---------- diff editor ----------
let diff: monaco.editor.IStandaloneDiffEditor | null = null;
let changes: monaco.editor.ILineChange[] = [];
let revealFirst = false;
let glyphs: Record<Side, monaco.editor.IEditorDecorationsCollection> | null = null;

const ed = (side: Side) => (side === "left" ? diff!.getOriginalEditor() : diff!.getModifiedEditor());
const model = (side: Side) => ed(side).getModel()!;

function editor(): monaco.editor.IStandaloneDiffEditor {
  if (diff) return diff;
  diff = monaco.editor.createDiffEditor(editorHost, {
    readOnly: false,
    originalEditable: true,
    automaticLayout: true,
    renderSideBySide: !prefs.inline,
    useInlineViewWhenSpaceIsLimited: false,
    ignoreTrimWhitespace: prefs.whitespace,
    hideUnchangedRegions: { enabled: prefs.collapse },
    wordWrap: prefs.wrap ? "on" : "off",
    diffAlgorithm: "advanced",
    renderOverviewRuler: true,
    renderMarginRevertIcon: false, // we draw our own arrows for both directions
    glyphMargin: true,
    enableSplitViewResizing: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontFamily: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 19,
    maxComputationTime: 10000,
    maxFileSize: 64,
    stickyScroll: { enabled: false },
  });
  glyphs = {
    left: diff.getOriginalEditor().createDecorationsCollection(),
    right: diff.getModifiedEditor().createDecorationsCollection(),
  };
  diff.onDidUpdateDiff(() => {
    changes = diff!.getLineChanges() ?? [];
    renderGlyphs();
    if (revealFirst && changes.length) {
      revealFirst = false;
      goToChange(0);
    } else updateCounter();
  });
  for (const side of ["left", "right"] as Side[]) {
    const e = ed(side);
    e.onDidChangeCursorPosition(() => updateCounter());
    e.onDidChangeModelContent(() => updateDirty());
    // Click on a gutter arrow copies that change to the other side.
    e.onMouseDown((ev) => {
      if (ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = ev.target.position?.lineNumber;
      const i = changes.findIndex((c) => startLine(c, side) === line);
      if (i >= 0) copyChange(changes[i], side === "left" ? "right" : "left");
    });
  }
  return diff;
}

const startLine = (c: monaco.editor.ILineChange, side: Side) =>
  Math.max(1, side === "left" ? c.originalStartLineNumber : c.modifiedStartLineNumber);

function renderGlyphs() {
  if (!glyphs || !doc) return;
  const deco = (side: Side, cls: string, hover: string): monaco.editor.IModelDeltaDecoration[] =>
    changes.map((c) => ({
      range: new monaco.Range(startLine(c, side), 1, startLine(c, side), 1),
      options: { glyphMarginClassName: `codicon ${cls} da-copy`, glyphMarginHoverMessage: { value: hover } },
    }));
  glyphs.left.set(doc.editable.right ? deco("left", "codicon-arrow-right", "Copy this change to the right") : []);
  glyphs.right.set(doc.editable.left ? deco("right", "codicon-arrow-left", "Copy this change to the left") : []);
}

function focusedSide(): Side {
  return diff?.getOriginalEditor().hasTextFocus() ? "left" : "right";
}

function currentChangeIndex(side: Side = focusedSide()): number {
  if (!diff) return -1;
  const line = ed(side).getPosition()?.lineNumber ?? 0;
  let idx = -1;
  changes.forEach((c, i) => { if (startLine(c, side) <= line) idx = i; });
  return idx;
}

function updateCounter() {
  if (!changes.length) { counter.textContent = "No changes"; return; }
  const i = currentChangeIndex();
  counter.textContent = i < 0 ? `${changes.length} changes` : `${i + 1} / ${changes.length}`;
}

function goToChange(i: number) {
  if (!diff || !changes.length) return;
  i = (i + changes.length) % changes.length;
  const side = focusedSide();
  const line = startLine(changes[i], side);
  ed(side).setPosition({ lineNumber: line, column: 1 });
  ed(side).revealLineInCenter(line);
  updateCounter();
}

function stepChange(dir: 1 | -1) {
  if (!changes.length) return;
  const side = focusedSide();
  const i = currentChangeIndex(side);
  if (dir > 0) goToChange(i + 1);
  else {
    // If the cursor is past the start of the current change, "previous" goes to its start first.
    const line = ed(side).getPosition()?.lineNumber ?? 0;
    goToChange(i >= 0 && line > startLine(changes[i], side) ? i : i - 1);
  }
}

/** Make the `to` side of one change identical to the other side. */
function copyChange(c: monaco.editor.ILineChange, to: Side) {
  if (!doc?.editable[to]) return;
  const from: Side = to === "left" ? "right" : "left";
  const src = model(from);
  const dst = model(to);
  const [sStart, sEnd] = from === "left" ? [c.originalStartLineNumber, c.originalEndLineNumber] : [c.modifiedStartLineNumber, c.modifiedEndLineNumber];
  const [dStart, dEnd] = to === "left" ? [c.originalStartLineNumber, c.originalEndLineNumber] : [c.modifiedStartLineNumber, c.modifiedEndLineNumber];
  const eol = dst.getEOL();
  const lines = sEnd === 0 ? [] : src.getLinesContent().slice(sStart - 1, sEnd);
  const text = lines.join(eol);
  const last = dst.getLineCount();
  let range: monaco.Range;
  let insert: string;
  if (dEnd === 0) {
    // Destination has nothing here: insert after line dStart (0 = top of file).
    if (dStart === 0) { range = new monaco.Range(1, 1, 1, 1); insert = text + eol; }
    else { const col = dst.getLineMaxColumn(dStart); range = new monaco.Range(dStart, col, dStart, col); insert = eol + text; }
  } else if (lines.length) {
    range = new monaco.Range(dStart, 1, dEnd, dst.getLineMaxColumn(dEnd));
    insert = text;
  } else if (dEnd < last) {
    range = new monaco.Range(dStart, 1, dEnd + 1, 1); insert = "";
  } else if (dStart > 1) {
    range = new monaco.Range(dStart - 1, dst.getLineMaxColumn(dStart - 1), dEnd, dst.getLineMaxColumn(dEnd)); insert = "";
  } else {
    range = dst.getFullModelRange(); insert = "";
  }
  dst.pushStackElement();
  dst.pushEditOperations([], [{ range, text: insert }], () => null);
  dst.pushStackElement();
}

function copyAll(to: Side) {
  if (!doc?.editable[to] || !diff) return;
  const src = model(to === "left" ? "right" : "left");
  const dst = model(to);
  dst.pushStackElement();
  dst.pushEditOperations([], [{ range: dst.getFullModelRange(), text: src.getValue() }], () => null);
  dst.pushStackElement();
}

function copyCurrent(to: Side) {
  const i = currentChangeIndex();
  if (i >= 0) copyChange(changes[i], to);
  else if (changes.length) copyChange(changes[0], to);
}

function isDirty(side: Side) {
  return !!(doc && diff?.getModel() && model(side).getAlternativeVersionId() !== doc.saved[side]);
}

function updateDirty() {
  const l = isDirty("left");
  const r = isDirty("right");
  saveBtn.disabled = !(l || r);
  for (const [side, d] of [["left", l], ["right", r]] as const) {
    const el = $(`#meta-${side}`);
    el.querySelector(".dirty-dot")?.remove();
    if (d) el.insertAdjacentHTML("afterbegin", `<span class="dirty-dot" title="Unsaved changes">●</span>`);
  }
}

async function save(): Promise<boolean> {
  if (!doc || !session || busy) return false;
  const s = session;
  const d = doc;
  const sides = (["left", "right"] as Side[]).filter(isDirty);
  if (!sides.length) return true;
  saveBtn.disabled = true;
  try {
    for (const side of sides) {
      const m = model(side);
      const version = m.getAlternativeVersionId();
      const content = m.getValue();
      await invoke("write_file", { root: side === "left" ? s.left : s.right, rel: d.rel, content });
      d.saved[side] = version;
      d.exists[side] = true;
      if (d.item) {
        d.item[side] = { is_dir: false, size: new TextEncoder().encode(content).length, mtime: Date.now() / 1000 };
      }
    }
    invalidateListings();
    afterSave(d);
    setStatus(`Saved ${sides.map((x) => (x === "left" ? "left" : "right")).join(" and ")} · ${d.title}`, $("#status-right").textContent ?? "");
    return true;
  } catch (e) {
    showError(`Save failed: ${e}`);
    return false;
  } finally {
    updateDirty();
  }
}

/** Refresh the file's status in the tree after saving. */
function afterSave(d: Doc) {
  const same = model("left").getValue() === model("right").getValue();
  const status: Status = d.exists.left && d.exists.right ? (same ? "same" : "changed") : d.exists.left ? "left_only" : "right_only";
  setDiffHeader(d.title, d.item ? status : null);
  $("#meta-left").innerHTML = metaHtml("left", joinLabel(session!.left, d.rel), d.item?.left);
  $("#meta-right").innerHTML = metaHtml("right", joinLabel(session!.right, d.rel), d.item?.right);
  if (!d.item || !session?.items) return;
  d.item.status = status;
  rebuildTree();
}

/** Rebuild the tree from session.items, keeping expansion, and refresh counts/status. */
function rebuildTree() {
  if (!session?.items) return;
  session.root = buildTree(session.items);
  tree.setData(session.root, true);
  renderSummary();
  if (doc?.item) {
    const badge = $("#diff-status");
    badge.className = `badge ${doc.item.status}`;
    badge.textContent = STATUS_LABEL[doc.item.status];
  }
}

let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  setTimeout(() => { rebuildQueued = false; rebuildTree(); }, 200);
}

function renderSummary() {
  if (!session?.items) return;
  const c = updateChips(session.items);
  const total = c.same + c.changed + c.left_only + c.right_only + c.pending;
  let text = `${total} files · ${c.changed} changed · ${c.left_only} left only · ${c.right_only} right only · ${c.same} identical`;
  if (verifyState && verifyState.done < verifyState.total) {
    text += ` · checking contents ${verifyState.done.toLocaleString()} / ${verifyState.total.toLocaleString()}…`;
  }
  setStatus(`${text} — ${timingText}`, `${session.left}  ↔  ${session.right}`);
}

/**
 * Content-check "pending" files in the background: small files first, a few batches in flight
 * at once (they share the SSH connection), updating the tree as results arrive.
 */
async function verifyPending(gen: number) {
  const s = session;
  if (!s?.items) return;
  const pending = s.items.filter((i) => i.status === "pending").sort((a, b) => (a.left?.size ?? 0) - (b.left?.size ?? 0));
  if (!pending.length) return;
  const chunks: Item[][] = [];
  let cur: Item[] = [];
  let bytes = 0;
  for (const it of pending) {
    cur.push(it);
    bytes += it.left?.size ?? 0;
    if (cur.length >= 400 || bytes >= 48 << 20) { chunks.push(cur); cur = []; bytes = 0; }
  }
  if (cur.length) chunks.push(cur);

  const t0 = performance.now();
  verifyState = { done: 0, total: pending.length };
  renderSummary();
  let next = 0;
  let failed: string | null = null;
  const worker = async () => {
    while (next < chunks.length && gen === compareGen) {
      const chunk = chunks[next++];
      try {
        const res = await invoke<Status[]>("verify", { left: s.left, right: s.right, paths: chunk.map((i) => i.path) });
        if (gen !== compareGen) return;
        chunk.forEach((it, i) => { it.status = res[i]; });
      } catch (e) {
        if (gen !== compareGen) return;
        failed ??= String(e);
        chunk.forEach((it) => { it.status = "changed"; });
      }
      verifyState!.done += chunk.length;
      queueRebuild();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (gen !== compareGen) return;
  timingText += ` · contents checked in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  verifyState = null;
  rebuildTree();
  if (failed) showError(`Some files couldn't be content-checked (marked as changed): ${failed}`);
}

/** Before leaving a file with unsaved edits, offer to save. Returns false if saving failed. */
async function resolveUnsaved(): Promise<boolean> {
  if (!doc || !(isDirty("left") || isDirty("right"))) return true;
  const yes = await ask(`Save your changes to ${doc.title}?`, {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: "Save",
    cancelLabel: "Discard",
  });
  return yes ? save() : true;
}

function setModels(path: string, a: string, b: string) {
  const e = editor();
  const lang = languageFor(path);
  const old = e.getModel();
  e.setModel({
    original: monaco.editor.createModel(a, lang),
    modified: monaco.editor.createModel(b, lang),
  });
  old?.original.dispose();
  old?.modified.dispose();
  e.getModifiedEditor().setPosition({ lineNumber: 1, column: 1 });
  e.getModifiedEditor().setScrollTop(0);
  changes = [];
  revealFirst = true;
}

// ---------- formatting ----------
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(s: number, seconds = false): string {
  if (!s) return "";
  const d = new Date(s * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ":" + p(d.getSeconds()) : ""}`;
}
function joinLabel(base: string, rel: string) {
  return rel ? `${base.replace(/\/+$/, "")}/${rel}` : base;
}
function metaHtml(side: Side, loc: string, e: Entry | null | undefined, f?: FileSide) {
  const tag = `<span class="side-tag ${side}">${side === "left" ? "L" : "R"}</span>`;
  const ro = f && f.lossy ? `<span class="ro-note">· read-only (not UTF-8)</span>` : "";
  if (f && !f.exists) return `${tag}<span class="loc">${esc(loc)}</span><span>· missing (saving creates it)</span>`;
  const bits = [e ? fmtSize(e.size) : f ? fmtSize(f.size) : "", e ? fmtTime(e.mtime) : ""].filter(Boolean);
  return `${tag}<span class="loc">${esc(loc)}</span>${bits.length ? `<span>· ${bits.join(" · ")}</span>` : ""}${ro}`;
}

// ---------- ui state helpers ----------
function showError(msg: string | null) {
  errorBox.classList.toggle("hidden", !msg);
  errorBox.textContent = msg ?? "";
}
function showMessage(html: string | null) {
  msgBox.classList.toggle("hidden", !html);
  msgBox.innerHTML = html ? `<div>${html}</div>` : "";
}
function setMode(mode: "welcome" | "dir" | "file") {
  main.classList.toggle("welcome-mode", mode === "welcome");
  main.classList.toggle("file-mode", mode === "file");
}
function setBusy(b: boolean) {
  busy = b;
  compareBtn.disabled = b;
  compareBtn.classList.toggle("busy", b);
  compareBtn.querySelector(".label")!.textContent = b ? "Comparing…" : "Compare";
}
function setStatus(left: string, right = "") {
  $("#status-left").textContent = left;
  $("#status-right").textContent = right;
}
function setDiffHeader(path: string, status: Status | null, info = false) {
  diffHead.classList.remove("hidden");
  diffHead.classList.toggle("info-mode", info);
  diffMeta.classList.toggle("hidden", info);
  msgBox.classList.toggle("info", info);
  $("#diff-path").textContent = path;
  const badge = $("#diff-status");
  badge.className = `badge ${status ?? ""}`;
  badge.textContent = status ? STATUS_LABEL[status] : "";
  badge.classList.toggle("hidden", !status);
}
function clearDiffPane(html: string) {
  doc = null;
  info = null;
  msgBox.classList.remove("info");
  diffHead.classList.add("hidden");
  diffMeta.classList.add("hidden");
  showMessage(html);
}
function setEditTools(enabled: boolean) {
  for (const id of ["#copy-to-left", "#copy-to-right", "#copy-all-left", "#copy-all-right"]) {
    ($(id) as HTMLButtonElement).disabled = !enabled;
  }
  if (doc) {
    ($("#copy-to-left") as HTMLButtonElement).disabled = !doc.editable.left;
    ($("#copy-all-left") as HTMLButtonElement).disabled = !doc.editable.left;
    ($("#copy-to-right") as HTMLButtonElement).disabled = !doc.editable.right;
    ($("#copy-all-right") as HTMLButtonElement).disabled = !doc.editable.right;
  }
}

// ---------- recent ----------
function remember(l: string, r: string) {
  store.set("left", l);
  store.set("right", r);
  store.set("filters", filtersIn.value);
  for (const [key, v] of [["recentLeft", l], ["recentRight", r]] as const) {
    const list = [v, ...store.get<string[]>(key, []).filter((x) => x !== v)].slice(0, 12);
    store.set(key, list);
  }
}

// ---------- tree ----------
const tree = new TreeView($("#tree"), (n) => openFile(n));

function updateChips(items: Item[]) {
  const counts: Record<Status, number> = { same: 0, changed: 0, left_only: 0, right_only: 0, pending: 0 };
  for (const it of items) if (!it.is_dir) counts[it.status]++;
  document.querySelectorAll<HTMLButtonElement>("#chips .chip").forEach((c) => {
    const s = c.dataset.s as Status;
    c.querySelector("b")!.textContent = String(counts[s]);
    c.classList.toggle("on", tree.active.has(s));
  });
  return counts;
}

function findNode(root: Node, path: string): Node | null {
  for (const c of root.children) {
    if (c.path === path) return c;
    if (c.isDir && path.startsWith(c.path + "/")) return findNode(c, path);
  }
  return null;
}

// ---------- actions ----------
async function runCompare() {
  if (busy) return;
  const l = leftIn.value.trim();
  const r = rightIn.value.trim();
  if (!l || !r) {
    showError("Enter both a left and a right path.");
    (l ? rightIn : leftIn).focus();
    return;
  }
  if (!(await resolveUnsaved())) return;
  const gen = ++compareGen;
  verifyState = null;
  showError(null);
  setBusy(true);
  setStatus(`Comparing ${l} ↔ ${r} …`);
  try {
    const out = await invoke<Outcome>("compare", { left: l, right: r, filters: filtersIn.value, method });
    remember(l, r);
    doc = null;
    $("#title-text").textContent = `${out.left}  ↔  ${out.right}`;
    if (out.kind === "file") {
      session = {
        left: out.left,
        right: out.right,
        mode: "file",
        file: { left: out.left_entry, right: out.right_entry, binary: out.binary },
        declined: new Set(),
      };
      setMode("file");
      tree.clear();
      busy = false;
      await showFile("", out.left.split("/").pop() || out.left, null);
      return;
    }
    const root = buildTree(out.items);
    session = { left: out.left, right: out.right, mode: "dir", root, items: out.items, declined: new Set() };
    setMode("dir");
    tree.setData(root);
    const sec = (ms: number) => (ms / 1000).toFixed(2);
    timingText = `connect ${sec(out.timings.probe_ms)} s · list ${sec(out.timings.list_ms)} s`;
    const c = updateChips(out.items);
    const total = c.same + c.changed + c.left_only + c.right_only + c.pending;
    renderSummary();
    void verifyPending(gen);
    const keep = tree.selected && findNode(root, tree.selected);
    if (keep && !keep.isDir) {
      busy = false;
      tree.select(keep, true);
    } else {
      tree.selected = null;
      clearDiffPane(
        total === 0
          ? `<strong>No files</strong>Both folders are empty, or everything is excluded.`
          : c.changed + c.left_only + c.right_only + c.pending === 0
            ? `<strong>Folders are identical</strong>${total} files compared.`
            : `<strong>Select a file</strong>Use ↑ ↓ in the list, or <kbd>]</kbd> to jump to the next difference.`,
      );
      $("#tree").focus();
    }
  } catch (e) {
    showError(String(e));
    setStatus("Comparison failed");
  } finally {
    setBusy(false);
  }
}

let openTimer: number | undefined;
function openFile(n: Node) {
  // Small debounce so holding ↓ doesn't fire a read for every row.
  clearTimeout(openTimer);
  openTimer = window.setTimeout(() => {
    if (!n.item || doc?.rel === n.item.path) return;
    void showFile(n.item.path, n.item.path, n.item);
  }, 60);
}

type InfoReason = "binary" | "too_large" | "large" | "declined" | "binary_content";
interface InfoState { rel: string; title: string; item: Item | null; reason: InfoReason; content?: Status | "checking" | string }
let info: InfoState | null = null;

async function showFile(rel: string, title: string, item: Item | null, force = false) {
  if (!session) return;
  if (!(await resolveUnsaved())) return;
  const s = session;
  const le = item?.left ?? s.file?.left ?? null;
  const re = item?.right ?? s.file?.right ?? null;
  info = null;
  if (!force) {
    const biggest = Math.max(le?.size ?? 0, re?.size ?? 0);
    const binary = item ? item.binary : !!s.file?.binary;
    let reason: InfoReason | null = null;
    if (biggest > MAX_DIFF) reason = "too_large";
    else if (binary) reason = "binary";
    else if (s.declined.has(rel)) reason = "declined";
    else if (biggest > LARGE_TEXT) reason = "large";
    if (reason) {
      ++loadToken; // cancel any in-flight load
      return showInfo({ rel, title, item, reason });
    }
  }
  const token = ++loadToken;
  const lLoc = joinLabel(s.left, rel);
  const rLoc = joinLabel(s.right, rel);
  doc = null;
  setEditTools(false);
  saveBtn.disabled = true;
  setDiffHeader(title, item?.status ?? null);
  showMessage(null);
  $("#meta-left").innerHTML = metaHtml("left", lLoc, le);
  $("#meta-right").innerHTML = metaHtml("right", rLoc, re);
  const leftExists = s.mode === "file" || (!!le && !le.is_dir);
  const rightExists = s.mode === "file" || (!!re && !re.is_dir);
  const slow = window.setTimeout(() => token === loadToken && showMessage("Loading…"), 250);
  let pair: FilePair;
  try {
    pair = await invoke<FilePair>("read_pair", { left: s.left, right: s.right, rel, leftExists, rightExists });
  } catch (e) {
    pair = { left: errSide(String(e)), right: errSide(String(e)) };
  } finally {
    clearTimeout(slow);
  }
  if (token !== loadToken) return; // a newer selection won
  $("#meta-left").innerHTML = metaHtml("left", lLoc, le, pair.left);
  $("#meta-right").innerHTML = metaHtml("right", rLoc, re, pair.right);

  const err = pair.left.error ?? pair.right.error;
  if (err) return showMessage(`<strong>Can't load this file</strong>${esc(err)}`);
  if (pair.left.binary || pair.right.binary) {
    return showInfo({ rel, title, item, reason: "binary_content" });
  }
  showMessage(null);
  setModels(title, pair.left.text, pair.right.text);
  const editable = { left: !pair.left.lossy, right: !pair.right.lossy };
  diff!.updateOptions({ originalEditable: editable.left, readOnly: !editable.right });
  doc = {
    rel,
    title,
    item,
    editable,
    exists: { left: pair.left.exists, right: pair.right.exists },
    saved: { left: model("left").getAlternativeVersionId(), right: model("right").getAlternativeVersionId() },
  };
  setEditTools(true);
  updateDirty();
  if (s.mode === "file") {
    setStatus(pair.left.text === pair.right.text ? "Files are identical" : "Files differ", `${s.left}  ↔  ${s.right}`);
  }
}
/** Info card for binary / large files: size and date per side, no content loaded. */
function showInfo(st: InfoState) {
  if (!session) return;
  info = st;
  doc = null;
  setEditTools(false);
  saveBtn.disabled = true;
  const s = session;
  const le = st.item?.left ?? s.file?.left ?? null;
  const re = st.item?.right ?? s.file?.right ?? null;
  const status = st.item?.status ?? null;
  setDiffHeader(st.title, status, true);

  const exists = (e: Entry | null) => !!e && !e.is_dir;
  const big = Math.max(le?.size ?? 0, re?.size ?? 0);
  const headline: Record<InfoReason, [string, string]> = {
    binary: ["Binary file", "Compared by size and date. Contents aren't loaded."],
    binary_content: ["Binary file", "This file contains binary data, so there's no text diff."],
    too_large: ["Too large to diff", `Files over ${fmtSize(MAX_DIFF)} are compared by size and date only.`],
    large: ["Large text file", `This file is ${fmtSize(big)}. Loading the diff may be slow, especially over SSH.`],
    declined: ["Large text file", "Showing file info only."],
  };
  const [h, sub] = headline[st.reason];

  // Verdict from metadata (and the content check, if one ran).
  let verdict: string;
  let tone: Status = "same";
  if (!exists(le) || !exists(re)) {
    verdict = exists(le) ? "Only on the left" : "Only on the right";
    tone = exists(le) ? "left_only" : "right_only";
  } else if (le!.size !== re!.size) {
    const d = re!.size - le!.size;
    verdict = `Different size (right is ${d > 0 ? "+" : "−"}${fmtSize(Math.abs(d))})`;
    tone = "changed";
  } else if (Math.abs(le!.mtime - re!.mtime) < 1) {
    verdict = "Same size and modified time";
  } else {
    verdict = `Same size, different date (right is ${le!.mtime < re!.mtime ? "newer" : "older"})`;
    tone = "changed";
  }
  let content = "";
  if (st.content === "checking") content = `<div class="info-check">Checking contents…</div>`;
  else if (st.content === "same") content = `<div class="info-check same">✓ Contents are identical</div>`;
  else if (st.content === "changed") content = `<div class="info-check changed">Contents differ</div>`;
  else if (st.content) content = `<div class="info-check left_only">${esc(st.content)}</div>`;

  const cell = (e: Entry | null, f: (e: Entry) => string) => (exists(e) ? f(e!) : `<span class="muted">—</span>`);
  const bytes = (n: number) => `${fmtSize(n)}${n >= 1024 ? ` <span class="muted">(${n.toLocaleString()} bytes)</span>` : ""}`;
  const lLoc = joinLabel(s.left, st.rel);
  const rLoc = joinLabel(s.right, st.rel);
  const both = exists(le) && exists(re);
  const buttons: string[] = [];
  if (st.reason === "large") {
    buttons.push(`<button class="primary small" data-act="diff">Show diff</button>`);
    buttons.push(`<button class="toggle" data-act="decline">Just show info</button>`);
  } else {
    if (both && st.content !== "checking") buttons.push(`<button class="toggle" data-act="check" title="Hash both files where they live, nothing is downloaded">Check contents</button>`);
    if (st.reason === "binary" || st.reason === "declined") buttons.push(`<button class="toggle" data-act="diff">${st.reason === "binary" ? "Show as text anyway" : "Show diff"}</button>`);
  }

  showMessage(
    `<div class="info-card">
      <div class="info-head"><div class="info-ico">${st.reason.startsWith("binary") ? "⬢" : "≡"}</div>
        <div><strong>${h}</strong><div class="muted">${sub}</div></div></div>
      ${st.reason === "large" ? `<div class="info-ask">Load the full diff?</div>` : ""}
      <table class="info-table">
        <tr><th></th><th><span class="side-tag left">L</span></th><th><span class="side-tag right">R</span></th></tr>
        <tr><td>Path</td><td class="loc">${esc(lLoc)}</td><td class="loc">${esc(rLoc)}</td></tr>
        <tr><td>Size</td><td>${cell(le, (e) => bytes(e.size))}</td><td>${cell(re, (e) => bytes(e.size))}</td></tr>
        <tr><td>Modified</td><td>${cell(le, (e) => fmtTime(e.mtime, true))}</td><td>${cell(re, (e) => fmtTime(e.mtime, true))}</td></tr>
      </table>
      <div class="info-verdict ${tone}"><i></i>${verdict}</div>
      ${content}
      ${buttons.length ? `<div class="info-actions">${buttons.join("")}</div>` : ""}
    </div>`,
  );
}

msgBox.addEventListener("click", async (e) => {
  const act = (e.target as HTMLElement).closest("button")?.dataset.act;
  if (!act || !info || !session) return;
  const st = info;
  const s = session;
  if (act === "diff") {
    s.declined.delete(st.rel);
    void showFile(st.rel, st.title, st.item, true);
  } else if (act === "decline") {
    s.declined.add(st.rel);
    showInfo({ ...st, reason: "declined" });
  } else if (act === "check") {
    showInfo({ ...st, content: "checking" });
    try {
      const [res] = await invoke<Status[]>("verify", { left: s.left, right: s.right, paths: [st.rel] });
      if (info?.rel !== st.rel || session !== s) return;
      if (st.item && (st.item.status === "same" || st.item.status === "changed" || st.item.status === "pending")) {
        st.item.status = res;
        rebuildTree();
      }
      showInfo({ ...st, content: res });
    } catch (err) {
      if (info?.rel === st.rel) showInfo({ ...st, content: `Check failed: ${err}` });
    }
  }
});

const errSide = (e: string): FileSide => ({ exists: true, binary: false, lossy: false, size: 0, text: "", error: e });

// ---------- wiring ----------
compareBtn.addEventListener("click", runCompare);
for (const input of [leftIn, rightIn, filtersIn]) {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void runCompare(); } });
}
$("#swap").addEventListener("click", () => {
  [leftIn.value, rightIn.value] = [rightIn.value, leftIn.value];
  store.set("left", leftIn.value);
  store.set("right", rightIn.value);
  if (session) void runCompare();
});
document.querySelectorAll<HTMLButtonElement>(".browse").forEach((b) =>
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    const picked = await openDialog({ directory: b.dataset.dir === "1", multiple: false });
    if (typeof picked === "string") {
      (b.dataset.side === "left" ? leftIn : rightIn).value = picked;
      store.set(b.dataset.side!, picked);
    }
  }),
);

const methodEl = $("#method");
const syncMethod = () =>
  methodEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.v === method));
methodEl.addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest("button")?.dataset.v as Method | undefined;
  if (!v || v === method) return;
  method = v;
  store.set("method", v);
  syncMethod();
  if (session?.mode === "dir") void runCompare();
});
syncMethod();

$("#chips").addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest(".chip") as HTMLElement | null;
  if (!chip) return;
  const s = chip.dataset.s as Status;
  if (tree.active.has(s)) tree.active.delete(s);
  else tree.active.add(s);
  chip.classList.toggle("on", tree.active.has(s));
  tree.refresh();
});
// File filter with VS Code-style options.
const searchOpts = store.get<SearchOptions>("searchOpts", { matchCase: false, wholeWord: false, regex: false });
function applySearch() {
  document.querySelectorAll<HTMLButtonElement>(".sopt").forEach((b) =>
    b.classList.toggle("on", searchOpts[b.dataset.o as keyof SearchOptions]),
  );
  const m = buildMatcher(searchIn.value, searchOpts);
  const err = m && typeof m === "object" ? m.error : null;
  $("#search-box").classList.toggle("invalid", !!err);
  const errEl = $("#search-error");
  errEl.classList.toggle("hidden", !err);
  errEl.textContent = err ?? "";
  tree.matcher = err ? null : (m as ((p: string) => boolean) | null);
  tree.refresh();
}
function toggleSearchOpt(k: keyof SearchOptions) {
  searchOpts[k] = !searchOpts[k];
  store.set("searchOpts", searchOpts);
  applySearch();
}
document.querySelectorAll<HTMLButtonElement>(".sopt").forEach((b) => {
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
  b.addEventListener("click", () => toggleSearchOpt(b.dataset.o as keyof SearchOptions));
});
searchIn.addEventListener("input", applySearch);
applySearch();
searchIn.addEventListener("keydown", (e) => {
  if (e.altKey && (e.metaKey || e.ctrlKey)) {
    const k = ({ KeyC: "matchCase", KeyW: "wholeWord", KeyR: "regex" } as Record<string, keyof SearchOptions>)[e.code];
    if (k) { e.preventDefault(); e.stopPropagation(); toggleSearchOpt(k); return; }
  }
  if (e.key === "Escape") { searchIn.value = ""; applySearch(); $("#tree").focus(); }
  if (e.key === "ArrowDown") { e.preventDefault(); $("#tree").focus(); }
});
$("#expand-all").addEventListener("click", () => tree.expandAll(true));
$("#collapse-all").addEventListener("click", () => tree.expandAll(false));

$("#prev-change").addEventListener("click", () => stepChange(-1));
$("#next-change").addEventListener("click", () => stepChange(1));
$("#copy-to-left").addEventListener("click", () => copyCurrent("left"));
$("#copy-to-right").addEventListener("click", () => copyCurrent("right"));
$("#copy-all-left").addEventListener("click", () => copyAll("left"));
$("#copy-all-right").addEventListener("click", () => copyAll("right"));
saveBtn.addEventListener("click", () => void save());

function applyPrefs() {
  document.querySelectorAll<HTMLButtonElement>(".toggle[data-opt]").forEach((t) =>
    t.classList.toggle("on", !!prefs[t.dataset.opt as keyof typeof prefs]),
  );
  main.classList.toggle("inline", prefs.inline);
  diff?.updateOptions({
    renderSideBySide: !prefs.inline,
    ignoreTrimWhitespace: prefs.whitespace,
    hideUnchangedRegions: { enabled: prefs.collapse },
    wordWrap: prefs.wrap ? "on" : "off",
  });
}
document.querySelectorAll<HTMLButtonElement>(".toggle[data-opt]").forEach((t) =>
  t.addEventListener("click", () => {
    const k = t.dataset.opt as keyof typeof prefs;
    prefs[k] = !prefs[k];
    store.set("prefs", prefs);
    applyPrefs();
  }),
);
applyPrefs();

// Sidebar resize.
const resizer = $("#resizer");
resizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  resizer.classList.add("drag");
  const move = (ev: MouseEvent) => {
    const w = Math.max(200, Math.min(window.innerWidth - 400, ev.clientX));
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    store.set("sidebarW", w);
  };
  const up = () => {
    resizer.classList.remove("drag");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// Global shortcuts (capture phase so they work while the editor has focus).
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
    if (mod && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      e.stopPropagation();
      copyCurrent(e.key === "ArrowLeft" ? "left" : "right");
      return;
    }
    if (mod && e.key === "Enter") { e.preventDefault(); void runCompare(); return; }
    if (mod && e.key.toLowerCase() === "r") { e.preventDefault(); if (session) void runCompare(); return; }
    if (e.key === "F7" || (e.altKey && !mod && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      e.preventDefault();
      e.stopPropagation();
      stepChange(e.shiftKey || e.key === "ArrowUp" ? -1 : 1);
    }
  },
  true,
);
window.addEventListener("keydown", (e) => {
  const inText = (e.target as HTMLElement).closest("input, textarea, .monaco-editor") !== null;
  if (inText || session?.mode !== "dir") return;
  if (e.key === "]") { e.preventDefault(); tree.jumpChanged(1); }
  else if (e.key === "[") { e.preventDefault(); tree.jumpChanged(-1); }
  else if (e.key === "/") { e.preventDefault(); searchIn.focus(); searchIn.select(); }
});

// ---------- theme: light / dark / auto ----------
type Theme = "light" | "dark" | "auto";
let theme: Theme = store.get<Theme>("theme", "auto");
if (!["light", "dark", "auto"].includes(theme)) theme = "auto";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  // With a native theme set, the webview's prefers-color-scheme follows it too.
  const dark = theme === "dark" || (theme === "auto" && systemDark.matches);
  monaco.editor.setTheme(dark ? "vs-dark" : "vs");
  document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((b) => b.classList.toggle("on", b.dataset.v === theme));
}
systemDark.addEventListener("change", applyTheme);
$("#theme").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest("button")?.dataset.v as Theme | undefined;
  if (!v || v === theme) return;
  theme = v;
  store.set("theme", v);
  // Native window chrome (traffic lights, dialogs) follows too; null = system.
  void getCurrentWindow().setTheme(v === "auto" ? null : v).catch(() => {});
  applyTheme();
});
void getCurrentWindow().setTheme(theme === "auto" ? null : theme).catch(() => {});
applyTheme();

// Custom title strip: drag to move, double-click per the OS setting (works with macOS "Fill").
const appWindow = getCurrentWindow();
const titlebar = $("#titlebar");
if (!/Mac/.test(navigator.userAgent)) document.body.classList.add("no-titlebar");
let dblAction: Promise<string> | null = null;
titlebar.addEventListener("mousedown", async (e) => {
  if (e.button !== 0) return;
  if (e.detail === 2) {
    const action = await (dblAction ??= invoke<string>("titlebar_double_click_action").catch(() => "Maximize"));
    if (action === "Minimize") await appWindow.minimize();
    else if (action !== "None") await appWindow.toggleMaximize();
  } else if (e.detail === 1) {
    await appWindow.startDragging();
  }
});

setMode("welcome");
(leftIn.value ? compareBtn : leftIn).focus();
