import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { panelVersion } from '../lib/buildInfo';
import { SegmentConfig, SegmentId, moveSegment } from '../segments';

interface ConfigChipProps {
  config: SegmentConfig;
  /** Display names, which may be derived from live data (e.g. the active caps). */
  labels: Record<SegmentId, string>;
  /** Hover text explaining what each segment reports. */
  descriptions: Record<SegmentId, string>;
  onChange: (next: SegmentConfig) => void;
  onReset: () => void;
  /**
   * The version a newer release offers, when one is known.
   *
   * Passed in rather than read here so the popover does not run a second update
   * check of its own: the strip already holds that state, and one reading
   * shared is what keeps the footer and the update chip from ever disagreeing.
   */
  updateVersion?: string | null;
}

const POPOVER_WIDTH = 250;
const POPOVER_MAX_HEIGHT = 260;
const GAP = 6;

/**
 * Which copy of the panel you are running (GET-106).
 *
 * The gear popover is the right home for it: it is already the only surface
 * about the panel itself rather than about the focused session, and the update
 * setting is right above. Before this, GET-99's update chip could say a newer
 * release existed while nothing anywhere named the version you were on -- so
 * "should I update?" was a question the panel raised and could not answer.
 *
 * When an update is known the two versions are shown together, because that is
 * the one moment the current version is worth more than as a footnote. The
 * plain version stays the default shape: being up to date is the common case
 * and should read as unremarkable.
 *
 * Exported for its tests, as `buildSegments` is: the popover it lives in only
 * mounts on a click, so there is no way to reach it from a static render.
 */
export function VersionFooter({ updateVersion }: { updateVersion: string | null }) {
  const version = panelVersion();

  // Only outside a real `vite build`, where the define step that supplies
  // `__PANEL_VERSION__` has not run. Saying so beats a dangling "Status Panel"
  // that looks like a truncated string.
  if (!version) {
    return (
      <div className="sp-popover-version" title="This build was not produced by `npm run build`, so it carries no manifest version.">
        Status Panel — development build
      </div>
    );
  }

  return (
    <div
      className="sp-popover-version"
      title={
        updateVersion
          ? `Running ${version}. ${updateVersion} has been released -- the Update chip in the strip will install it.`
          : `Running ${version}.`
      }
    >
      Status Panel {version}
      {updateVersion && <span className="sp-popover-version-new"> → {updateVersion} available</span>}
    </div>
  );
}

/**
 * Gear chip: pick which segments appear and in what order.
 *
 * The popover is portalled to <body> and positioned fixed. The strip is a
 * scroll container (`overflow-y: auto`), which clips absolutely positioned
 * descendants -- an in-flow popover renders but is never visible.
 */
export function ConfigChip({
  config,
  labels,
  descriptions,
  onChange,
  onReset,
  updateVersion = null,
}: ConfigChipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Prefer below the chip; flip above when the panel is too short.
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow >= POPOVER_MAX_HEIGHT + GAP
        ? rect.bottom + GAP
        : Math.max(GAP, rect.top - POPOVER_MAX_HEIGHT - GAP);

    const left = Math.min(
      Math.max(GAP, rect.right - POPOVER_WIDTH),
      window.innerWidth - POPOVER_WIDTH - GAP,
    );

    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onReflow = () => reposition();

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, reposition]);

  const toggleVisible = (id: SegmentId) => {
    const hidden = config.hidden.includes(id)
      ? config.hidden.filter((entry) => entry !== id)
      : [...config.hidden, id];
    onChange({ ...config, hidden });
  };

  const move = (id: SegmentId, delta: number) => {
    onChange({ ...config, order: moveSegment(config.order, id, delta) });
  };

  const popover =
    open && position
      ? createPortal(
          <div
            className="sp-popover"
            role="dialog"
            aria-label="Segment settings"
            ref={popoverRef}
            style={{ left: position.left, top: position.top }}
          >
            <div className="sp-popover-header">
              <span>Segments</span>
              <button type="button" className="sp-popover-reset" onClick={onReset}>
                Reset
              </button>
            </div>

            <ul className="sp-popover-list">
              {config.order.map((id, index) => {
                const visible = !config.hidden.includes(id);
                return (
                  <li key={id} className="sp-popover-row">
                    <label className="sp-popover-label" title={descriptions[id]}>
                      <input type="checkbox" checked={visible} onChange={() => toggleVisible(id)} />
                      <span className={visible ? undefined : 'sp-popover-muted'}>
                        {labels[id]}
                      </span>
                    </label>
                    <span className="sp-popover-actions">
                      <button
                        type="button"
                        onClick={() => move(id, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${labels[id]} earlier`}
                      >
                        <span className="material-symbols-outlined">arrow_upward</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => move(id, 1)}
                        disabled={index === config.order.length - 1}
                        aria-label={`Move ${labels[id]} later`}
                      >
                        <span className="material-symbols-outlined">arrow_downward</span>
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="sp-popover-header sp-popover-section">
              <span>Behavior</span>
            </div>
            <ul className="sp-popover-list">
              <li className="sp-popover-row">
                <label
                  className="sp-popover-label"
                  title="Open this panel automatically when Nimbalyst starts. Nimbalyst only restores sidebar panels on its own, so the panel opens itself."
                >
                  <input
                    type="checkbox"
                    checked={config.autoOpen}
                    onChange={() => onChange({ ...config, autoOpen: !config.autoOpen })}
                  />
                  <span>Open on startup</span>
                </label>
              </li>
              <li className="sp-popover-row">
                <label
                  className="sp-popover-label"
                  title={
                    'Ask github.com every few hours whether a newer release of this extension ' +
                    'exists, and show a chip when one does. Nimbalyst never updates a ' +
                    'GitHub-installed extension on its own, so without this you stay on the ' +
                    'version you installed. Nothing appears while you are up to date, and turning ' +
                    'this off stops the request being made at all.'
                  }
                >
                  <input
                    type="checkbox"
                    checked={config.checkForUpdates}
                    onChange={() =>
                      onChange({ ...config, checkForUpdates: !config.checkForUpdates })
                    }
                  />
                  <span>Check for updates</span>
                </label>
              </li>
            </ul>

            <VersionFooter updateVersion={updateVersion} />
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="sp-config">
      <button
        type="button"
        ref={buttonRef}
        className="sp-chip sp-config-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Choose segments and order"
      >
        <span className="material-symbols-outlined sp-chip-icon">tune</span>
      </button>
      {popover}
    </div>
  );
}
