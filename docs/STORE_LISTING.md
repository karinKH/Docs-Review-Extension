# Chrome Web Store listing (draft)

Copy these into the Chrome Web Store developer dashboard. Fields marked "dashboard" are form fields there.

## Name
Review Pen

## Summary (up to 132 characters)
Annotate long AI-written documents and turn every comment into one precise revision prompt. Local only, no AI calls.

## Category (dashboard)
Productivity, Workflow & Planning

## Language (dashboard)
English

## Description

Review Pen makes reviewing long AI-generated documents fast, and makes the AI's next revision accurate.

Open a Markdown file, a raw GitHub link, or a Google Doc, Sheet or Slides deck. Select any text and press C to comment. Widen the selection to the sentence, paragraph or whole section with Alt + ↑. Mark each comment as a rewrite, deletion, expansion, fact-check or question, with a priority. On a Google page you can also pin design and layout comments straight onto the slide, page or cell, each with a screenshot of the area.

Then copy one prompt. Every item carries the exact quoted text, the words around it, line numbers and the section, so the AI changes the right sentence and nothing else. Formats for coding agents (Claude Code, Cursor, Copilot), chat assistants, JSON, YAML, or your own template.

When the revised version comes back, Review Pen finds your comments again, shows what changed, and flags changes you didn't ask for. Paste the AI's checklist reply and anything it skipped goes into the next prompt as a second attempt.

Also:
• Exact-text comments can be applied directly to the file, with no AI and no tokens.
• Annotated PDF with marks, numbers and callout boxes.
• Review files you can save and share, and W3C Web Annotation export.
• Hebrew, Arabic and mixed right-to-left text laid out correctly.
• Command palette (Ctrl+K) and full keyboard shortcuts.

Private by design: Review Pen never calls an AI service, has no server, no analytics and no account. Your documents and reviews stay on your computer.

## Single purpose (dashboard)
Review Pen lets you annotate documents and compile your annotations into a revision prompt for an AI tool, entirely on your computer.

## Permission justifications (dashboard)

- **storage / unlimitedStorage:** Stores the user's reviews (comments and document versions) and settings locally in IndexedDB and extension storage. Long documents with several review rounds exceed the default quota.
- **scripting:** Registers a content script, only on raw-Markdown hosts the user explicitly allowed, that passes the page's Markdown text to the extension's viewer. Also used, as a fallback, to read the export of a Google file from inside the Google tab the user opened.
- **activeTab:** When the user clicks the toolbar button: reads the active tab's URL to open that Google Docs/Sheets/Slides file or Markdown page in the viewer; on a Google file, injects a small comment layer into that tab so the user can place pins and boxes on the page; and captures a screenshot of that tab (tabs.captureVisibleTab) for each pin or box, only while that tab is the one showing. Screenshots are stored locally in the extension's IndexedDB and never transmitted.
- **Optional host permissions (raw.githubusercontent.com, gist.githubusercontent.com, gitlab.com):** Requested only when the user clicks "Allow these sites", to open raw Markdown files from those hosts.
- **Optional host permissions (docs.google.com, *.googleusercontent.com):** Requested only when the user opens a Google file and clicks "Allow and open", to download Google's export of that one file (Google serves downloads from googleusercontent.com).
- **Remote code:** No. All code is bundled in the package; the Content Security Policy forbids remote and inline scripts and eval.

## Data usage disclosures (dashboard)
- Collected data: **none**. Review Pen does not collect or transmit any user data.
- Certify: does not sell data; does not use or transfer data for purposes unrelated to the single purpose; does not use data for creditworthiness or lending.

## Privacy policy URL (dashboard)
https://github.com/karinKH/Docs-Review-Extension/blob/main/PRIVACY.md

## Screenshots (dashboard)
Generate them with `SHOTS_DIR=<folder> npx playwright test screenshots` (after `npm run build`), then crop or resize to 1280×800. Suggested order: review in progress; prompt tab; rounds tab with changes; annotated PDF; Hebrew document.

## Before submitting
- Build and zip: `npm run build && npm run zip` (the zip is in `.output/`).
- Bump `version` in package.json for each upload.
- A one-time $5 developer registration is required by Google.
