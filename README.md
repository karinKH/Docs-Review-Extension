# Review Pen

Review long AI-written documents the way an editor would, then hand the AI **one precise prompt** that says exactly what to change and where.

Select a word, a sentence, a paragraph or a whole section. Say what should change. Review Pen records the exact location of every comment and turns your review into a copy-ready prompt for a coding agent (Claude Code, Cursor, Codex) or a chat assistant (Claude, ChatGPT, Gemini).

> **Zero AI, zero servers.** Review Pen never calls an AI model, never needs an API key and never sends your document anywhere. Parsing, locating, prompt building and token counting all run inside your browser, and the same review always produces the same prompt.

**Status:** step 1 of 4, the Markdown reviewer. Google Docs, Slides and Sheets, PDF export and multi-round reviews come next (see [Roadmap](#roadmap)).

---

## What it does

- **Opens Markdown beautifully.** Headings, tables, task lists, footnotes, GitHub callouts (`> [!NOTE]`), syntax-highlighted code, math (KaTeX) and Mermaid diagrams. Hebrew, Arabic and other right-to-left text is laid out per paragraph, so mixed Hebrew and English documents read correctly.
- **Comments on exactly what you mean.** Select text and press **C**. Put the cursor in a word and press **Alt + ↑** to widen the selection to the sentence, paragraph, section or whole document. Hover a paragraph and click **+** in the margin to take the whole block; on a heading, it takes the whole section.
- **Two kinds of comment.**
  - *Instruction*: describe the change ("Shorten to one sentence") and let the AI choose the words.
  - *Exact text*: type the replacement yourself; the prompt tells the AI to apply it character for character.
- **Intent and priority.** Rewrite, Delete, Expand, Shorten, Move, Fact-check, Format or Question, marked Must fix, Suggestion or Nit. Refer to another comment with `#3`.
- **A prompt that an AI can follow.** Every item carries the quoted original text, the text just before and after it, line numbers and the section path. Formats: coding agent (Markdown), chat assistant (XML), JSON, YAML or your own template. Long reviews can be split into parts by token budget.
- **Pre-flight checks** before you copy: empty instructions, replacements that change nothing, overlapping comments that contradict each other, `#refs` to comments that don't exist, and quotes that appear more than once.
- **Rendered and raw views.** Comment on the formatted page or on the Markdown source with line numbers. Both point to the same place in the file.
- **Progress tracking.** Tick sections off as reviewed in the table of contents; it shows how many open comments each section has.
- **Saves as you go.** Reviews are kept in this browser, with undo and redo. If the file changes, Review Pen finds your comments again and tells you which ones it couldn't place.
- **Keyboard first.** Press **?** in the viewer for every shortcut.

## Install (from source, for now)

Review Pen is not on the Chrome Web Store yet. To try it:

1. Install [Node.js](https://nodejs.org/) 22 or newer.
2. In a terminal, inside this folder:
   ```sh
   npm install
   npm run build
   ```
3. Open `chrome://extensions` in Chrome, turn on **Developer mode** (top right), click **Load unpacked** and choose the `.output/chrome-mv3` folder.
4. The welcome page opens. Click **Try the guided demo** to learn the basics in two minutes.

### Optional setup

- **Open local `.md` files straight from disk.** On `chrome://extensions`, open Review Pen's **Details** and turn on **Allow access to file URLs**. Then any `.md` file you open in Chrome shows up in Review Pen. (The **Open a Markdown file** button on the welcome page works without this.) Add `#raw` to the address to see the plain file instead.
- **Raw GitHub, GitLab and Gist links.** On the welcome page, click **Allow these sites**. Review Pen then opens raw `.md` links on `raw.githubusercontent.com`, `gist.githubusercontent.com` and `gitlab.com`, and no other sites.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| C | Comment on the selection |
| Alt + ↑ / Alt + scroll up | Widen the selection: word, sentence, paragraph, section, document |
| Alt + ↓ / Alt + scroll down | Narrow it again |
| J / K | Next / previous comment |
| E or Enter | Edit the selected comment |
| R | Switch between rendered and raw view |
| T | Show or hide the table of contents |
| P | Open the prompt |
| Ctrl/⌘ + Shift + C | Copy the prompt |
| Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z | Undo, redo |
| Ctrl/⌘ + Enter | Save a comment |
| Esc | Close or cancel |

## Privacy and security

In plain terms: Review Pen treats every document as untrusted, keeps everything on your computer, and asks for as little access as it can.

- **Nothing leaves your browser.** No AI calls, no analytics, no accounts, no servers of ours. The only network requests are the ones you ask for: downloading a raw Markdown link you opened, or loading a document's remote images after you click **Load images**.
- **Remote images are blocked by default**, because loading an image tells its server that you opened the document.
- **Documents can't run code.** Markdown may contain HTML. Review Pen removes scripts, event handlers (`onclick` and friends), `javascript:` links and other unsafe markup with a sanitizer that follows GitHub's rules. On top of that, the extension's Content Security Policy (`script-src 'self'; object-src 'self'`) forbids any script that didn't ship with the extension, so even a sanitizer bug could not run code from a document. Mermaid diagrams run in strict mode.
- **No remote code.** Every library is bundled and pinned to an exact version. There is no `eval` or `new Function` in the build.
- **Minimal permissions.**
  - `storage` and `unlimitedStorage` keep your reviews in this browser (IndexedDB), so long documents don't hit a quota.
  - `scripting` is used only to register the small script that hands raw `.md` pages on the sites *you* allowed to the viewer.
  - Site access is *optional* and limited to the three hosts above; Review Pen asks for it only when you click **Allow these sites**.
- **Your data is yours.** Reviews are stored in IndexedDB on this device only. Delete any review from the welcome page. Removing the extension deletes everything.

Found a security problem? Please report it privately through this repository's **Security** tab rather than in a public issue.

## Development

```sh
npm install          # also generates WXT types
npm run dev          # Chrome with the extension loaded and live reload
npm run build        # production build in .output/chrome-mv3
npm run zip          # store-ready zip
npm run typecheck    # TypeScript, no output
npm test             # unit tests (Vitest)
npm run test:e2e     # end-to-end tests in a real Chromium (Playwright), run after a build
```

Golden files for the prompt formats live in `tests/golden/`. If you change the prompt wording on purpose, regenerate them with `UPDATE_GOLDEN=1 npm test` and review the diff.

### How it fits together

| Folder | What lives there |
| --- | --- |
| `src/core/markdown` | Markdown to HTML with a source map: every rendered character knows its offset in the original file. |
| `src/core/anchor` | Turning a selection into a durable anchor (quote, context, offsets, lines, heading path), widening scopes, re-finding anchors after edits. |
| `src/core/compile` | The deterministic prompt compiler, its presets, a small safe template engine and token counting. |
| `src/core/preflight.ts` | Checks run before you copy a prompt. |
| `src/ui` | The viewer, welcome page, components and styles (React). |
| `src/entrypoints` | Extension entry points: background worker, `.md` page hand-off script, viewer and welcome pages. |
| `tests/unit`, `tests/e2e` | Unit tests with fixtures and golden files; browser tests that load the built extension. |

Built with [WXT](https://wxt.dev), React, TypeScript, unified/remark/rehype, Shiki, KaTeX, Mermaid, Dexie and js-tiktoken.

## Roadmap

1. **Markdown reviewer** (this release): viewer, anchoring, comments, prompt compiler, local storage.
2. **Review loop and exports:** annotated PDF export, review files you can save and share, fuzzy re-anchoring when the AI rewrites around your comments, a diff of what changed between rounds, and watching a local file for changes.
3. **Google Workspace:** annotate Google Docs, Slides and Sheets in place, using your existing Google sign-in, with export as a fallback. The review panel moves into Chrome's side panel.
4. **Polish and release:** accessibility audit, more languages, Chrome Web Store listing.

## License

The license is being finalised. Until a license file says otherwise, **all rights are reserved** by the author: you may read the code here, but you may not copy, modify or redistribute it. See [LICENSE](LICENSE).
