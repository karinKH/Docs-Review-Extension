import { defineConfig } from 'wxt';

// Review Pen extension configuration.
// Security notes:
// - No remote code: every library is bundled at build time.
// - Minimal permissions: only storage + scripting are always on.
//   Web hosts are optional and requested at runtime, with a click.
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Review Pen',
    description:
      'Annotate long documents and turn your comments into precise, copy-ready revision prompts for AI tools. Local-first, no AI calls.',
    // activeTab: when you click the toolbar button, Review Pen may read that
    // one tab's address (to open a Google file or a .md link). No warning.
    permissions: ['storage', 'unlimitedStorage', 'scripting', 'activeTab'],
    optional_host_permissions: [
      'https://raw.githubusercontent.com/*',
      'https://gist.githubusercontent.com/*',
      'https://gitlab.com/*',
      // Google Docs, Sheets and Slides: requested only when you open one.
      'https://docs.google.com/*',
      'https://*.googleusercontent.com/*',
    ],
    action: { default_title: 'Review Pen' },
    content_security_policy: {
      // Strict: scripts only from the extension package, no eval, no remote code.
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'; form-action 'none'",
    },
    minimum_chrome_version: '114',
  },
});
