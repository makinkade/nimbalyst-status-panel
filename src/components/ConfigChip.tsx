import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SegmentConfig, SegmentId, moveSegment } from '../segments';

interface ConfigChipProps {
  config: SegmentConfig;
  /** Display names, which may be derived from live data (e.g. the active caps). */
  labels: Record<SegmentId, string>;
  /** Hover text explaining what each segment reports. */
  descriptions: Record<SegmentId, string>;
  onChange: (next: SegmentConfig) => void;
  onReset: () => void;
}

const POPOVER_WIDTH = 250;
const POPOVER_MAX_HEIGHT = 260;
const GAP = 6;

/**
 * Gear chip: pick which segments appear and in what order.
 *
 * The popover is portalled to <body> and positioned fixed. The strip is a
 * scroll container (`overflow-y: auto`), which clips absolutely positioned
 * descendants -- an in-flow popover renders but is never visible.
 */
export function ConfigChip({ config, labels, descriptions, onChange, onReset }: ConfigChipProps) {
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
            </ul>
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
