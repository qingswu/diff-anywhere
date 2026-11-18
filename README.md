# Diff Anywhere

A small Tauri 2 app for visually comparing files and folders, locally or over SSH.

## Paths
- Local: `~/code/app`, `/etc/nginx/nginx.conf`
- Remote: `host:/srv/app`, `user@host:~/app`, `host:relative/path` (relative to the remote home)
- File vs folder: compares the file against the same-named file inside the folder.

SSH uses your system `ssh` (`~/.ssh/config`, keys, agent, ProxyJump) with a shared
control connection. `BatchMode` is on, so use key or agent auth, not passwords.

## Autocomplete
Both path boxes complete as you type (`Tab` accepts, `↑/↓` pick and fill the box, `Esc` restores what you typed).
In an empty or closed box, `↑/↓` cycles through recent paths; `Enter` compares. Last paths are remembered.
Suggestions cover:
local paths, SSH host aliases from `~/.ssh/config` (including `Include`d files),
and remote paths once you've typed `host:`. Listings are cached for 15 s.

## Editing
Both sides are editable. Gutter arrows (→ / ←) copy one change to the other side;
`⇐ All` / `All ⇒` copy the whole file. `⌘S` saves the modified side(s) locally or over SSH
(missing files and parent folders are created). Undo with `⌘Z`. Files that aren't valid UTF-8
open read-only so they can't be corrupted.

## Binary and large files
Clicking a binary file (by type) shows an info card instead of a diff: size and modified time
for each side plus a verdict, without reading the files. **Check contents** hashes both files
where they live; **Show as text anyway** loads a diff if the type was misdetected.
Text files over 4 MB ask before loading the diff; choosing **Just show info** treats the file
like a binary for the rest of the session. Files over 32 MB are info-only.

## Excludes
Comma/semicolon/newline-separated, gitignore-like:
- `node_modules`, `.git`, `*.log`: a name pattern, matched at any depth
- `/build`, `src/gen`: matched against the path from the compared root
- Anything inside an excluded folder is skipped. Name patterns are pruned on the remote side.

## Compare methods
Results appear as soon as both trees are listed; files whose contents need checking show `?`
and are verified in the background (small files first, several batches in parallel over the
shared SSH connection). Hashes (MD5) are computed where the files live, so nothing is transferred.
- **Smart** (default): text files are compared by content; known binary types (images, archives,
  executables, model weights, databases, …) and files over 64 MB by size + date only
- **Content**: every same-size pair is compared by content
- **Size + date**: never reads files

The status bar shows how long connecting, listing and content checks took.

## Keys
`⌘↵` compare · `⌘R` re-compare · `↑/↓` browse files · `[` `]` prev/next changed file ·
`F7` / `⇧F7` (or `⌥↓/⌥↑`) next/prev change · `/` filter files ·
`⌥⌘←` / `⌥⌘→` copy current change · `⌘S` save

## Develop
```sh
npm install
npm run tauri dev                  # run with hot reload
npx tauri build --bundles app      # release .app (~5 MB)
cd src-tauri && cargo test
```

## License
MIT. See [LICENSE](LICENSE).
