<p align="center"><img src="build/icon.png" width="96" alt=""></p>

<p align="center"><b>English</b> · <a href="README.fr.md">Français</a></p>

# Younesh

A free, open-source terminal for Windows that keeps every session in a sidebar, organized in colored folders. No account, no subscription, no telemetry.

![Younesh](docs/screenshot.png)

## Install

Download from the [Releases](https://github.com/jonasmelheb/younesh/releases) page:

- `Younesh-Setup-x.y.z.exe` installs Younesh for the current user (no admin rights needed, Start menu shortcut). After that it updates itself: the new version downloads in the background and installs when you quit (can be turned off in Settings).
- `Younesh-x.y.z.msi` is the same as an MSI package, handy for IT deployment or silent installs (`msiexec /i Younesh-x.y.z.msi /qn`). It does not update itself; Younesh tells you when a new version is out.
- `Younesh-Portable-x.y.z.exe` runs without installing. It does not update itself, it only tells you when a new version is out.

## Features

- **Sessions in a sidebar**: each terminal session has a name, a working directory and a shell. PowerShell 7, Windows PowerShell, Command Prompt, Git Bash and WSL are detected automatically.
- **Colored folders**: create folders, pick a color (palette or custom), collapse them, rename them with a double-click. A session can have its own color too. A colored folder tints everything inside it with a pale shade of its color.
- **Drag and drop**: move sessions between folders and reorder sessions and folders.
- **Claude Code sessions**: the ✳ Claude button starts `claude` in the chosen directory. Each session keeps its own conversation and resumes it after Younesh is closed.
- **Claude is waiting**: when Claude stops working and waits for your answer, the session turns orange and the taskbar icon flashes (a Windows notification can be turned on in Settings). The terminal bell and OSC 9/777/99 notifications work too, for any program.
- **Git branch** under each session name in the sidebar, read straight from `.git` (no git process). The folder path is in the top bar.
- **Quick terminal**: the ›_ button opens a terminal right away in your home folder (`C:\Users\you`) with the default shell.
- **Session name from Claude**: `/rename` in Claude Code renames the session.
- **Find in terminal** with highlighted matches, and a **quick switcher** to jump to any session or action in a few keystrokes.
- **Fast**: GPU rendering (WebGL), configurable scrollback.
- **sbx sandboxes**: the ⧉ button creates a sandbox for a project in a few clicks: pick the folder, tick what to install inside (plugins, system packages…), done. The setup is split in three layers so a new sbx version only touches the sbx commands:
  - `cli`: the sbx commands themselves (create, open, exec, remove);
  - `setup`: one-time machine preparation (login, network policies, secrets), with a checklist;
  - `installs`: what can be installed inside a sandbox, chosen per project and sent as a single `exec`.

  The ⧉ button also **opens an existing sandbox**: Younesh lists the ones on the PC (`sbx ls`), even those created in another terminal, and reopens it in a discussion.
  The configuration is stored locally and can be imported or exported as JSON (right-click ⧉ → Configure sbx). Placeholders: `{projet}`, `{dossier}`, `{script}`, and `{secret:NAME}`, asked when the command runs and never saved.
- **Startup command**: e.g. `npm run dev`, restarted in one click.
- **Launch a whole folder**: ▶ on a folder starts all its sessions (server, Claude, tests…) at once; « Stop all » stops them.
- **Side by side**: open two sessions next to each other, with a draggable divider.
- **Drop a file** in the terminal to paste its path, quoted for your shell.
- **Restore content**: the last 1000 lines of each terminal come back after a restart.
- **Themes**: Dark, Midnight, Graphite, Light or automatic, cursor style, translucent sidebar (Windows 11 Mica, experimental).
- **Backup**: export and import your folders, sessions and settings to move from one PC to another.
- **Status dots**: green = running, blue = new output, red = exited, grey = idle (starts on click).
- Everything is saved locally: folders, colors, order and window size.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Quick switcher (sessions and actions) | Ctrl+Shift+P |
| New session | Ctrl+Shift+T |
| New Claude session | Ctrl+Shift+N |
| Terminal in your home folder | Ctrl+Shift+Q |
| New folder | Ctrl+Shift+D |
| Next / previous session | Ctrl+Tab / Ctrl+Shift+Tab |
| Close session | Ctrl+Shift+W |
| Rename | F2 |
| Find in terminal | Ctrl+Shift+F |
| Jump to the session waiting for you | Ctrl+Shift+U |
| Side by side on / off | Ctrl+Shift+E |
| Toggle sidebar | Ctrl+Shift+B |
| Font size | Ctrl + / Ctrl − / Ctrl 0 |
| Copy / paste | Ctrl+C (with a selection) or Ctrl+Shift+C / Ctrl+V |
| New line in Claude (also when started by hand in a shell) | Shift+Enter |

Right-click a session or a folder for all options. Middle-click a session to close it.

## Development

```bash
npm install
npm start          # run the app
npm run dist       # build the Windows .exe files (on Windows)
```

Releases are built from source by GitHub Actions for every `v*` tag ([workflow](.github/workflows/build.yml)).

Built with Electron, xterm.js and node-pty.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

- Committers and reviewers: [jonasmelheb](https://github.com/jonasmelheb)
- Approvers: [jonasmelheb](https://github.com/jonasmelheb)

Every release is built from this repository by GitHub Actions; only those builds are signed.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. Everything Younesh saves (folders, colors, sessions, settings) stays in a local file on the computer (`%APPDATA%\younesh`).

## License

[MIT](LICENSE)

---

<p align="right"><em>Made by Y</em></p>
