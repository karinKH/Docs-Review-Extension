# Review Pen privacy policy

_Last updated: 24 November 2026_

Review Pen is a Chrome extension for reviewing documents and turning your comments into prompts for AI tools. This policy explains what it does with your data. The short version: **your documents and reviews never leave your computer, and nobody, including the developer, receives any data from the extension.**

## What Review Pen stores, and where

- **Your reviews** (comments, document-wide instructions, review rounds, and the text of each version of the document you reviewed) are stored in your browser's own storage (IndexedDB) on your computer.
- **Your settings** (theme, prompt format, quick phrases) are stored in the extension's local storage on your computer.
- **Files you open** with the "Open a Markdown file" button are remembered as a file reference, so you can reopen them. Review Pen keeps no copy of the file outside your browser's storage.

You can delete any review from the welcome page. Removing the extension deletes everything it stored.

## What Review Pen sends over the network

Nothing, unless you ask it to open something from the web. In that case the only requests are:

- **Raw Markdown links** on raw.githubusercontent.com, gist.githubusercontent.com or gitlab.com, after you allow those sites: Review Pen downloads the file you opened.
- **Google Docs, Sheets and Slides**, after you allow docs.google.com and googleusercontent.com: Review Pen downloads Google's export of the one file you opened, using the Google sign-in already in your browser. It does not use the Google API, asks for no Google account access, and receives no password or token.
- **Images inside a document** load only after you click "Show images", because loading an image tells its server that the document was opened.

These requests go straight from your browser to the site that holds the file. Review Pen has no server of its own.

## What Review Pen never does

- It never calls an AI service or any other remote service. Prompts are built on your computer; you copy them yourself.
- It has no analytics, tracking, advertising, or crash reporting.
- It does not sell, share, or transfer any data, and it does not use data for any purpose other than the features you use.
- It does not read pages you visit, except: a `.md` page you open on a site you allowed (to show it in Review Pen), and the address of the current tab when you click the Review Pen toolbar button.

## Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `storage`, `unlimitedStorage` | Keep your reviews and settings on your computer; long documents would otherwise hit a size limit. |
| `scripting` | Hand raw `.md` pages on sites you allowed to the viewer; as a fallback, read a Google export from inside the Google tab you opened. |
| `activeTab` | When you click the toolbar button, read the current tab's address to open that Google file or `.md` page. |
| Optional: raw.githubusercontent.com, gist.githubusercontent.com, gitlab.com | Open raw Markdown links there. Asked only when you click "Allow these sites". |
| Optional: docs.google.com, googleusercontent.com | Download the export of a Google file you open. Asked only when you click "Allow and open". |
| File URLs (a switch you turn on in Chrome) | Show `.md` files you open from your disk. |

## Children

Review Pen is a general productivity tool and is not directed at children.

## Changes

If this policy changes, the new version will be published in this file, with a new date at the top. The full history is in the project's public repository: https://github.com/karinKH/Docs-Review-Extension

## Contact

Questions: open an issue at https://github.com/karinKH/Docs-Review-Extension/issues
