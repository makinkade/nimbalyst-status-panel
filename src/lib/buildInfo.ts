/**
 * What the build knows about itself.
 *
 * `vite.config.ts` replaces both identifiers with literals read out of
 * `manifest.json`, so these are the manifest's own values rather than anything
 * resolved at run time. Under vitest there is no `define` step and the
 * identifiers are simply absent -- hence the `typeof` guards, which are what
 * makes a bare reference to an undeclared global safe. A test that wants a
 * version passes one in instead; nothing here is a call site's only source.
 */

declare const __PANEL_VERSION__: string | null | undefined;
declare const __PANEL_REPOSITORY_URL__: string | null | undefined;

/** The manifest version of the code currently executing. */
export function panelVersion(): string | null {
  return typeof __PANEL_VERSION__ === 'string' && __PANEL_VERSION__ ? __PANEL_VERSION__ : null;
}

/** `marketplace.repositoryUrl`: where this build says its releases live. */
export function panelRepositoryUrl(): string | null {
  return typeof __PANEL_REPOSITORY_URL__ === 'string' && __PANEL_REPOSITORY_URL__
    ? __PANEL_REPOSITORY_URL__
    : null;
}
