// Path autocomplete for endpoint inputs: local paths, SSH hosts (~/.ssh/config) and remote paths.
import { invoke } from "@tauri-apps/api/core";
import { esc } from "./tree";

interface Child { name: string; is_dir: boolean }
type Kind = "dir" | "file" | "host" | "recent" | "info";
interface Suggestion { value: string; label: string; hl: number; kind: Kind }

const TTL = 15_000;
const cache = new Map<string, { at: number; p: Promise<Child[]> }>();
let hostsP: Promise<string[]> | null = null;

function listing(base: string): Promise<Child[]> {
  const hit = cache.get(base);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = invoke<Child[]>("list_children", { base });
  cache.set(base, { at: Date.now(), p });
  p.catch(() => cache.delete(base));
  return p;
}
const hosts = () => (hostsP ??= invoke<string[]>("ssh_hosts").catch(() => []));

/** Drop cached listings, e.g. after saving a new file. */
export function invalidateListings() { cache.clear(); }

type Parsed = { mode: "host"; text: string } | { mode: "path"; base: string; prefix: string } | null;

export function parseInput(text: string): Parsed {
  if (!text) return null;
  const local = /^[/~.\\]/.test(text) || /^[A-Za-z]:[\\/]/.test(text);
  const colon = text.indexOf(":");
  const slash = text.indexOf("/");
  if (!local && (colon < 0 || (slash >= 0 && slash < colon))) {
    return slash < 0 ? { mode: "host", text } : null;
  }
  if (text === "~") return { mode: "path", base: "", prefix: "~" };
  const last = text.lastIndexOf("/");
  if (last >= 0 && (local || last > colon)) return { mode: "path", base: text.slice(0, last + 1), prefix: text.slice(last + 1) };
  return { mode: "path", base: text.slice(0, colon + 1), prefix: text.slice(colon + 1) };
}

const ICON: Record<Kind, string> = {
  dir: `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  file: `<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/></svg>`,
  host: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`,
  recent: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  info: "",
};

export class Autocomplete {
  private box: HTMLElement;
  private items: Suggestion[] = [];
  private index = -1;
  private token = 0;
  private timer: number | undefined;
  /** What the user typed before arrow keys started previewing suggestions in the box. */
  private original: string | null = null;

  constructor(private input: HTMLInputElement, private recent: () => string[]) {
    this.box = document.createElement("div");
    this.box.className = "ac hidden";
    input.closest(".endpoint")!.appendChild(this.box);
    this.box.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
    this.box.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".ac-row") as HTMLElement | null;
      if (row?.dataset.i) this.accept(Number(row.dataset.i));
    });
    input.addEventListener("input", () => { this.original = null; this.schedule(); });
    input.addEventListener("focus", () => this.schedule(0));
    input.addEventListener("blur", () => this.close());
    // Registered before the app's own Enter handler so we can claim keys while the list is open.
    input.addEventListener("keydown", (e) => this.onKey(e));
  }

  private get open() { return !this.box.classList.contains("hidden"); }

  private schedule(delay = 60) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), delay);
  }

  close() {
    this.token++;
    this.box.classList.add("hidden");
    this.index = -1;
  }

  private async update() {
    if (document.activeElement !== this.input) return;
    const token = ++this.token;
    const text = this.input.value;
    const parsed = parseInput(text);
    const recent = this.recent().filter((r) => r !== text);
    const lc = text.toLowerCase();
    const recentMatches = (n: number): Suggestion[] =>
      recent
        .filter((r) => r.toLowerCase().startsWith(lc))
        .slice(0, n)
        .map((r) => ({ value: r, label: r, hl: text.length, kind: "recent" }));

    if (!parsed) return this.render(token, text ? [] : recentMatches(8));

    if (parsed.mode === "host") {
      const list = await hosts();
      if (token !== this.token) return;
      const hs: Suggestion[] = list
        .filter((h) => h.toLowerCase().startsWith(lc))
        .slice(0, 50)
        .map((h) => ({ value: h + ":", label: h + ":", hl: text.length, kind: "host" }));
      return this.render(token, [...recentMatches(3), ...hs]);
    }

    const { base, prefix } = parsed;
    if (base === "" && prefix === "~") return this.render(token, [{ value: "~/", label: "~/", hl: 1, kind: "dir" }]);
    const head = recentMatches(3);
    const slow = window.setTimeout(() => {
      if (token === this.token) this.render(token, [...head, { value: "", label: "Loading…", hl: 0, kind: "info" }], false);
    }, 150);
    try {
      const children = await listing(base);
      if (token !== this.token) return;
      const p = prefix.toLowerCase();
      const showHidden = prefix.startsWith(".");
      const matches: Suggestion[] = children
        .filter((c) => (showHidden || !c.name.startsWith(".")) && c.name.toLowerCase().startsWith(p))
        .filter((c) => !(c.name === prefix && !c.is_dir)) // already fully typed
        .slice(0, 200)
        .map((c) => ({
          value: base + c.name + (c.is_dir ? "/" : ""),
          label: c.name + (c.is_dir ? "/" : ""),
          hl: prefix.length,
          kind: c.is_dir ? "dir" : "file",
        }));
      this.render(token, [...head, ...matches]);
    } catch (e) {
      if (token !== this.token) return;
      const msg = String(e).split("\n")[0];
      this.render(token, [...head, { value: "", label: msg.length > 140 ? msg.slice(0, 140) + "…" : msg, hl: 0, kind: "info" }]);
    } finally {
      clearTimeout(slow);
    }
  }

  private render(token: number, items: Suggestion[], resetIndex = true) {
    if (token !== this.token) return;
    this.items = items;
    if (resetIndex) this.index = -1;
    if (!items.length) { this.box.classList.add("hidden"); return; }
    this.box.innerHTML = items
      .map((s, i) =>
        s.kind === "info"
          ? `<div class="ac-row info">${esc(s.label)}</div>`
          : `<div class="ac-row${i === this.index ? " on" : ""}" data-i="${i}">` +
            `<span class="ac-ico">${ICON[s.kind]}</span>` +
            `<span class="ac-label"><b>${esc(s.label.slice(0, s.hl))}</b>${esc(s.label.slice(s.hl))}</span>` +
            (s.kind === "host" || s.kind === "recent" ? `<span class="ac-kind">${s.kind}</span>` : "") +
            `</div>`,
      )
      .join("");
    this.box.classList.remove("hidden");
    this.box.querySelector(".ac-row.on")?.scrollIntoView({ block: "nearest" });
  }

  private move(d: number) {
    const selectable = this.items.map((s, i) => (s.kind === "info" ? -1 : i)).filter((i) => i >= 0);
    if (!selectable.length) return;
    const pos = selectable.indexOf(this.index);
    this.index = selectable[pos < 0 ? (d > 0 ? 0 : selectable.length - 1) : (pos + d + selectable.length) % selectable.length];
    this.render(this.token, this.items, false);
    // Preview the highlighted value in the box (Esc restores what was typed).
    this.original ??= this.input.value;
    this.setValue(this.items[this.index].value);
  }

  /** Open the full history list (not filtered by what's typed) with the latest entry filled in. */
  private showHistory() {
    const all = this.recent();
    if (!all.length) return;
    const token = ++this.token;
    this.render(token, all.map((r) => ({ value: r, label: r, hl: 0, kind: "recent" as Kind })));
    this.move(1);
  }

  private setValue(v: string) {
    this.input.value = v;
    this.input.setSelectionRange(v.length, v.length);
    this.input.scrollLeft = this.input.scrollWidth;
  }

  private accept(i: number) {
    const s = this.items[i];
    if (!s || s.kind === "info") return;
    this.original = null;
    this.setValue(s.value);
    if (s.kind === "dir" || s.kind === "host") this.schedule(0); // drill down
    else this.close();
  }

  private onKey(e: KeyboardEvent) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !this.open) {
      e.preventDefault();
      this.showHistory();
      return;
    }
    if (!this.open) return;
    let handled = true;
    switch (e.key) {
      case "ArrowDown": this.move(1); break;
      case "ArrowUp": this.move(-1); break;
      case "Tab": {
        const first = this.items.findIndex((s) => s.kind !== "info");
        if (this.index >= 0) this.accept(this.index);
        else if (first >= 0) this.accept(first);
        else handled = false;
        break;
      }
      case "Enter": {
        const s = this.items[this.index];
        if (s && (s.kind === "dir" || s.kind === "host")) this.accept(this.index); // drill down
        else { this.original = null; this.close(); handled = false; } // value is filled: let Enter compare
        break;
      }
      case "Escape":
        if (this.original !== null) { this.setValue(this.original); this.original = null; }
        this.close();
        break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
}
