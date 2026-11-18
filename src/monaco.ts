// Lean Monaco: core editor + syntax highlighting only (no language servers).
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };


const langCache = new Map<string, string>();
export function languageFor(path: string): string {
  const name = (path.split("/").pop() || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const key = ext || name;
  const hit = langCache.get(key);
  if (hit) return hit;
  let id = "plaintext";
  for (const l of monaco.languages.getLanguages()) {
    if (l.filenames?.some((f) => f.toLowerCase() === name) || (ext && l.extensions?.includes(ext))) {
      id = l.id;
      break;
    }
  }
  langCache.set(key, id);
  return id;
}

export { monaco };
