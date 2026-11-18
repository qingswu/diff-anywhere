// Virtualized file tree for folder comparisons.

export type Status = "same" | "changed" | "left_only" | "right_only" | "pending";
export interface Entry { is_dir: boolean; size: number; mtime: number }
export interface Item { path: string; is_dir: boolean; status: Status; left: Entry | null; right: Entry | null; binary: boolean }

export interface Node {
  name: string;
  path: string;
  isDir: boolean;
  status: Status;
  item?: Item;
  children: Node[];
  depth: number;
  /** Number of non-identical files beneath (dirs only). */
  diffs: number;
  /** Number of files beneath still being content-checked (dirs only). */
  pending: number;
}

const ROW = 26;
const TAG: Record<Status, string> = { same: "", changed: "M", left_only: "L", right_only: "R", pending: "?" };
const TITLE: Record<Status, string> = {
  same: "Identical",
  changed: "Changed",
  left_only: "Only on left",
  right_only: "Only on right",
  pending: "Checking contents…",
};
const ICON_DIR = `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/></svg>`;
const CARET = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;

export function buildTree(items: Item[]): Node {
  const root: Node = { name: "", path: "", isDir: true, status: "same", children: [], depth: -1, diffs: 0, pending: 0 };
  const byPath = new Map<string, Node>([["", root]]);
  const ensureDir = (path: string): Node => {
    let n = byPath.get(path);
    if (n) return n;
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : path.slice(0, cut));
    n = { name: path.slice(cut + 1), path, isDir: true, status: "same", children: [], depth: parent.depth + 1, diffs: 0, pending: 0 };
    parent.children.push(n);
    byPath.set(path, n);
    return n;
  };
  for (const it of items) {
    const cut = it.path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : it.path.slice(0, cut));
    const existing = byPath.get(it.path);
    if (existing) {
      existing.item = it;
      existing.status = it.status;
      continue;
    }
    const n: Node = {
      name: it.path.slice(cut + 1),
      path: it.path,
      isDir: it.is_dir,
      status: it.status,
      item: it,
      children: [],
      depth: parent.depth + 1,
      diffs: 0,
      pending: 0,
    };
    parent.children.push(n);
    byPath.set(it.path, n);
  }
  const finish = (n: Node) => {
    n.children.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    for (const c of n.children) {
      finish(c);
      n.diffs += c.isDir ? c.diffs : c.status !== "same" && c.status !== "pending" ? 1 : 0;
      n.pending += c.isDir ? c.pending : c.status === "pending" ? 1 : 0;
    }
    // A folder present on both sides is "changed" if anything inside differs.
    if (n.isDir && n.status === "same" && n.diffs > 0) n.status = "changed";
    else if (n.isDir && n.status === "same" && n.pending > 0) n.status = "pending";
  };
  finish(root);
  return root;
}

export class TreeView {
  private rows: Node[] = [];
  private root: Node | null = null;
  private expanded = new Set<string>();
  /** Folders the user collapsed by hand; never auto-expanded again. */
  private userCollapsed = new Set<string>();
  private inner: HTMLElement;
  selected: string | null = null;
  active = new Set<Status>(["changed", "left_only", "right_only"]);
  /** Path filter from the search box; null = no filter. */
  matcher: ((path: string) => boolean) | null = null;

  constructor(
    private el: HTMLElement,
    private onOpen: (n: Node) => void,
  ) {
    this.inner = el.querySelector(".tree-inner") as HTMLElement;
    el.addEventListener("scroll", () => this.paint());
    new ResizeObserver(() => this.paint()).observe(el);
    el.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".row") as HTMLElement | null;
      if (!row) return;
      const n = this.rows[Number(row.dataset.i)];
      if (!n) return;
      if (n.isDir && ((e.target as HTMLElement).closest(".caret") || this.selected === n.path)) this.toggle(n);
      this.select(n, true);
    });
    el.addEventListener("dblclick", (e) => {
      const row = (e.target as HTMLElement).closest(".row") as HTMLElement | null;
      const n = row && this.rows[Number(row.dataset.i)];
      if (n && n.isDir) this.toggle(n);
    });
    el.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** `preserve` keeps the user's expanded folders (used after saving a file). */
  setData(root: Node, preserve = false) {
    const keepSelection = this.selected;
    this.root = root;
    if (!preserve) { this.expanded.clear(); this.userCollapsed.clear(); }
    // Expand folders containing differences, so changes are visible right away.
    const walk = (n: Node) => {
      for (const c of n.children) {
        if (c.isDir && c.diffs > 0 && !this.userCollapsed.has(c.path)) { this.expanded.add(c.path); walk(c); }
      }
    };
    walk(root);
    this.selected = keepSelection;
    this.refresh();
  }

  clear() {
    this.root = null;
    this.selected = null;
    this.refresh();
  }

  expandAll(open: boolean) {
    if (!this.root) return;
    this.expanded.clear();
    this.userCollapsed.clear();
    if (open) {
      const walk = (n: Node) => n.children.forEach((c) => { if (c.isDir) { this.expanded.add(c.path); walk(c); } });
      walk(this.root);
    }
    this.refresh();
  }

  /** Recompute visible rows after data / filter changes. */
  refresh() {
    this.rows = [];
    if (this.root) {
      const m = this.matcher;
      const searching = m !== null;
      const visit = (n: Node): Node[] | null => {
        if (!n.isDir) {
          const ok = (this.active.has(n.status) || n.status === "pending") && (!m || m(n.path));
          return ok ? [n] : null;
        }
        const open = searching || this.expanded.has(n.path);
        const out: Node[] = [];
        let any = false;
        for (const c of n.children) {
          const r = visit(c);
          if (r) { any = true; if (open) out.push(...r); }
        }
        const selfOk =
          n.children.length === 0 && this.active.has(n.status) && (!m || m(n.path));
        if (!any && !selfOk) return null;
        return [n, ...out];
      };
      for (const c of this.root.children) {
        const r = visit(c);
        if (r) this.rows.push(...r);
      }
    }
    this.inner.style.height = `${this.rows.length * ROW}px`;
    this.paint(true);
  }

  private paint(force = false) {
    const top = this.el.scrollTop;
    const h = this.el.clientHeight;
    const first = Math.max(0, Math.floor(top / ROW) - 10);
    const last = Math.min(this.rows.length, Math.ceil((top + h) / ROW) + 10);
    const key = `${first}:${last}:${this.selected}`;
    if (!force && this.inner.dataset.key === key) return;
    this.inner.dataset.key = key;
    const searching = this.matcher !== null;
    let html = "";
    for (let i = first; i < last; i++) {
      const n = this.rows[i];
      const open = n.isDir && (searching || this.expanded.has(n.path));
      const cls = `row st-${n.status} ${n.status}${open ? " open" : ""}${n.path === this.selected ? " sel" : ""}`;
      // Folders use the same letters as files (M / L / R / ?); changed folders also show
      // how many differing files they contain.
      const count =
        n.isDir && n.status === "changed" && n.diffs
          ? `<span class="count" title="${n.diffs} differing file${n.diffs > 1 ? "s" : ""} inside">${n.diffs}</span>`
          : "";
      const tag = TAG[n.status] ? `${count}<span class="tag">${TAG[n.status]}</span>` : "";
      html +=
        `<div class="${cls}" data-i="${i}" style="top:${i * ROW}px;padding-left:${8 + n.depth * 14}px" title="${esc(n.path)} — ${TITLE[n.status]}">` +
        `<span class="caret">${n.isDir ? CARET : ""}</span>` +
        `<span class="ico">${n.isDir ? ICON_DIR : ICON_FILE}</span>` +
        `<span class="name">${esc(n.name)}</span>${tag}</div>`;
    }
    if (!this.rows.length && this.root) {
      html = `<div class="tree-empty">${this.root.children.length ? "Nothing matches the current filters." : "Both folders are empty."}</div>`;
    }
    this.inner.innerHTML = html;
  }

  private toggle(n: Node) {
    if (this.expanded.has(n.path)) { this.expanded.delete(n.path); this.userCollapsed.add(n.path); }
    else { this.expanded.add(n.path); this.userCollapsed.delete(n.path); }
    this.refresh();
  }

  select(n: Node, open: boolean) {
    this.selected = n.path;
    const i = this.rows.indexOf(n);
    if (i >= 0) {
      const y = i * ROW;
      if (y < this.el.scrollTop) this.el.scrollTop = y;
      else if (y + ROW > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y + ROW - this.el.clientHeight;
    }
    this.paint(true);
    if (open && !n.isDir) this.onOpen(n);
  }

  /** Jump to the next/previous non-identical file among visible rows. */
  jumpChanged(dir: 1 | -1) {
    if (!this.root) return;
    // Use a fully expanded ordering so collapsed folders are searched too.
    const all: Node[] = [];
    const walk = (n: Node) => n.children.forEach((c) => {
      if (c.isDir) walk(c);
      else if (c.status !== "same" && c.status !== "pending" && this.active.has(c.status)) all.push(c);
    });
    walk(this.root);
    if (!all.length) return;
    const cur = all.findIndex((n) => n.path === this.selected);
    const next = all[cur < 0 ? (dir > 0 ? 0 : all.length - 1) : (cur + dir + all.length) % all.length];
    // Reveal it.
    let p = next.path;
    while (p.includes("/")) { p = p.slice(0, p.lastIndexOf("/")); this.expanded.add(p); }
    this.refresh();
    this.select(next, true);
  }

  private onKey(e: KeyboardEvent) {
    const i = this.rows.findIndex((n) => n.path === this.selected);
    const cur = this.rows[i];
    const go = (j: number) => {
      const n = this.rows[Math.max(0, Math.min(this.rows.length - 1, j))];
      if (n) this.select(n, true);
    };
    switch (e.key) {
      case "ArrowDown": go(i + 1); break;
      case "ArrowUp": go(i < 0 ? 0 : i - 1); break;
      case "PageDown": go(i + Math.floor(this.el.clientHeight / ROW)); break;
      case "PageUp": go(i - Math.floor(this.el.clientHeight / ROW)); break;
      case "Home": go(0); break;
      case "End": go(this.rows.length - 1); break;
      case "ArrowRight":
        if (cur?.isDir && !this.expanded.has(cur.path)) this.toggle(cur);
        else go(i + 1);
        break;
      case "ArrowLeft":
        if (cur?.isDir && this.expanded.has(cur.path)) this.toggle(cur);
        else if (cur) {
          const parent = cur.path.includes("/") ? cur.path.slice(0, cur.path.lastIndexOf("/")) : null;
          const pn = parent && this.rows.find((n) => n.path === parent);
          if (pn) this.select(pn, false);
        }
        break;
      case "Enter":
        if (cur?.isDir) this.toggle(cur);
        else if (cur) this.onOpen(cur);
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export interface SearchOptions { matchCase: boolean; wholeWord: boolean; regex: boolean }

/**
 * Build a path matcher like VS Code's search box. All options off = case-insensitive substring.
 * Returns an error message instead for an invalid regular expression.
 */
export function buildMatcher(query: string, o: SearchOptions): ((path: string) => boolean) | null | { error: string } {
  if (!query) return null;
  if (!o.matchCase && !o.wholeWord && !o.regex) {
    const q = query.toLowerCase();
    return (p) => p.toLowerCase().includes(q);
  }
  let src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    const re = new RegExp(src, (o.matchCase ? "" : "i") + (o.wholeWord ? "u" : ""));
    return (p) => re.test(p);
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, "") };
  }
}
