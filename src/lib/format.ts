/**
 * Formatting ported from ~/.claude/statusline.ps1 so the panel and the CLI
 * status line read identically.
 */

/** 1234 -> "1.2K", 1234567 -> "1.2M" */
export function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Compact reset stamp: time today, weekday + time within a week, else date.
 * Mirrors Format-ResetTime.
 */
export function formatResetTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  if (date.toDateString() === now.toDateString()) return hhmm;

  const days = (date.getTime() - now.getTime()) / 86_400_000;
  if (days < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${hhmm}`;
  }
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`;
}

/**
 * Time remaining until a reset: "6h 47m", "47m", "2d 3h".
 * Null when the stamp is missing, unparseable, or already past.
 */
export function formatCountdown(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;

  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;

  const remainingMs = target - now;
  if (remainingMs <= 0) return null;

  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
}

/** Title-case a mode or effort token for display. */
export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** Last path segment, tolerating either separator and a trailing slash. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Permission mode label. Nimbalyst's workspace modes, mapped onto the same
 * vocabulary the status line uses.
 */
export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'bypass-all':
    case 'bypassPermissions':
      return 'Bypass';
    case 'allow-all':
    case 'acceptEdits':
    case 'auto':
      return 'Auto';
    case 'plan':
      return 'Plan';
    case 'ask':
    case 'default':
      return 'Default';
    default:
      return titleCase(mode);
  }
}
