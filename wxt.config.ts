import { defineConfig } from 'wxt';

// Review Pen extension configuration.
// Security notes:
// - No remote code: every library is bundled at build time.
// - Minimal permissions: only storage + scripting are always on.
//   Web hosts are optional and requested at runtime, with a click.
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  hooks: {
    // The Google page layer is added only on a toolbar click (activeTab), so it
    // needs no standing access to docs.google.com. WXT adds a content script's
    // address to host_permissions by default; take it out again, so installing
    // Review Pen grants no access to any website.
    'build:manifestGenerated': (_wxt, manifest) => {
      const hosts = (manifest.host_permissions ?? []).filter((h: string) => h !== 'https://docs.google.com/*');
      if (hosts.length) manifest.host_permissions = hosts;
      else delete manifest.host_permissions;
    },
  },
  manifest: ({ mode }) => ({
    // Browser-test build only (npm run build:e2e, separate output folder):
    // headless Chrome can't click the toolbar button, which is what grants
    // Review Pen access to a tab in the real extension. Never shipped.
    ...(mode === 'e2e' ? { host_permissions: ['<all_urls>'] } : {}),
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
  }),
});
