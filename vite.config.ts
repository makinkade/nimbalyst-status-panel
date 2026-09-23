import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { createExtensionConfig, mergeExtensionConfig } from '@nimbalyst/extension-sdk/vite';

/**
 * The manifest is the authority on what version is running, so the bundle is
 * built with that version baked into it rather than told its version at run
 * time. The install record Nimbalyst keeps carries a `version` too, but that is
 * what the host believes it installed -- for a symlinked dev install there is
 * no record at all, and for one built over the top of another it can name code
 * that is no longer there. The self-update check compares against the code
 * actually executing, which is this.
 */
const manifest = JSON.parse(
  readFileSync(new URL('./manifest.json', import.meta.url), 'utf-8'),
) as { version?: string; marketplace?: { repositoryUrl?: string } };

export default defineConfig(
  mergeExtensionConfig(createExtensionConfig({ entry: './src/index.ts' }), {
    define: {
      __PANEL_VERSION__: JSON.stringify(manifest.version ?? null),
      __PANEL_REPOSITORY_URL__: JSON.stringify(manifest.marketplace?.repositoryUrl ?? null),
    },
  }),
);
