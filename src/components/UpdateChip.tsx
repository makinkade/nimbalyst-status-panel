import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { copyText, installFromGitHub, openExternal } from '../lib/marketplace';
import { MUTED } from '../lib/thresholds';
import { AvailableUpdate } from '../lib/releaseCheck';

const POPOVER_WIDTH = 280;
const POPOVER_MAX_HEIGHT = 260;
const GAP = 6;

/**
 * "A newer release exists", and what to do about it.
 *
 * Deliberately the muted treatment the stale usage bars and the missing-value
 * placeholders already use, rather than a new alert style. A release is not an
 * alert: it is one more thing the strip knows, and the strip's existing
 * vocabulary for "worth mentioning, not worth interrupting you" is a muted
 * chip. GET-97 settled what those look like; this joins them rather than
 * competing with them.
 *
 * The chip has no empty state. Every other segment degrades to a placeholder
 * saying why it has nothing -- but those describe values that always exist and
 * are merely unavailable, and "no newer release" is not an unavailable value,
 * it is the ordinary condition of being up to date. A permanent `Update -` chip
 * would be a line of the strip spent saying nothing on almost every day the
 * panel is open. The config popover's Behavior row carries the explanation
 * instead, which is also where the user goes when they wonder about it.
 */
export function UpdateChip({ update }: { update: AvailableUpdate }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Same rule as the config popover: below the chip when the panel is tall
    // enough for it, flipped above when it is not.
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

  const { release, currentVersion, repositoryUrl } = update;

  return (
    <div className="sp-update">
      <button
        type="button"
        ref={buttonRef}
        className="sp-chip sp-update-button"
        style={{ borderColor: MUTED }}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Status Panel ${release.version} is available. You are running ${currentVersion}.`}
      >
        <span className="material-symbols-outlined sp-chip-icon" style={{ color: MUTED }}>
          system_update_alt
        </span>
        <span className="sp-chip-body">
          <span className="sp-label">Update</span>
          <span className="sp-value">{release.version}</span>
        </span>
      </button>

      {open && position
        ? createPortal(
            <UpdatePopover
              ref={popoverRef}
              update={update}
              position={position}
              repositoryUrl={repositoryUrl}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

type InstallState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'installed' }
  | { phase: 'failed'; error: string };

interface PopoverProps {
  update: AvailableUpdate;
  position: { left: number; top: number };
  repositoryUrl: string;
}

/**
 * The confirmation, and the manual path beside it.
 *
 * Installing is never automatic and never silent -- the whole reason this is a
 * popover rather than a toast is that the user has to press the button. And the
 * paste-this-URL instructions are always on screen rather than only appearing
 * after a failure: the install channel is unsanctioned ground, so the path that
 * cannot break is the one that should never be hidden.
 */
const UpdatePopover = forwardRef<HTMLDivElement, PopoverProps>(function UpdatePopover(
  { update, position, repositoryUrl },
  ref,
) {
  const [state, setState] = useState<InstallState>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);

  const { release, currentVersion } = update;

  const install = async () => {
    setState({ phase: 'installing' });
    const outcome = await installFromGitHub(repositoryUrl);
    setState(
      outcome.installed
        ? { phase: 'installed' }
        : { phase: 'failed', error: outcome.error ?? 'The install did not complete.' },
    );
  };

  const copy = async () => {
    if (!(await copyText(repositoryUrl))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div
      className="sp-popover sp-update-popover"
      role="dialog"
      aria-label="Update available"
      ref={ref}
      style={{ left: position.left, top: position.top }}
    >
      <div className="sp-popover-header">
        <span>Update available</span>
      </div>

      <p className="sp-update-summary">
        Status Panel <strong>{release.version}</strong> is out. You are running {currentVersion}.
      </p>

      <button
        type="button"
        className="sp-update-link"
        onClick={() => void openExternal(release.url)}
      >
        {release.name ?? `Release ${release.tag}`} — what changed
      </button>

      {state.phase === 'installed' ? (
        // The bundle running in this renderer was evaluated at startup, so the
        // panel on screen is still the old one however well the install went.
        // Saying "updated" here would be a claim the next five seconds of the
        // strip visibly contradict.
        <p className="sp-update-note sp-update-ok">
          Installed. Restart Nimbalyst to run {release.version} — the copy loaded in this window is
          still {currentVersion}.
        </p>
      ) : (
        <button
          type="button"
          className="sp-update-action"
          onClick={() => void install()}
          disabled={state.phase === 'installing'}
        >
          {state.phase === 'installing' ? 'Installing…' : `Update to ${release.version}`}
        </button>
      )}

      {state.phase === 'failed' && (
        <p className="sp-update-note sp-update-error">{state.error} Install it by hand instead:</p>
      )}

      <div className="sp-popover-header sp-popover-section">
        <span>Or install it yourself</span>
      </div>

      <p className="sp-update-note">
        Paste this into Settings → Extensions → Marketplace → Install from GitHub.
      </p>

      <div className="sp-update-url">
        <code>{repositoryUrl}</code>
        <button type="button" onClick={() => void copy()} aria-label="Copy the repository URL">
          <span className="material-symbols-outlined">{copied ? 'check' : 'content_copy'}</span>
        </button>
      </div>
    </div>
  );
});
