/**
 * @fileoverview Number and text formatting shared by the UI.
 *
 * License: BSD 3-Clause
 */

//
// CONSTANTS
//
const ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};
let currency = '$';

//
// PUBLIC
//

/** Sets the currency symbol used by fmt and fk. */
export function setCurrency(symbol: string): void {
  currency = symbol || '$';
}

/**
 * Formats money; negatives in parentheses, e.g. fmt(-12) === '($12)'.
 * @param v The amount.
 * @param d Decimal places.
 */
export function fmt(v: number, d = 0): string {
  const s = currency + Math.abs(v).toLocaleString(
      'en-US', {minimumFractionDigits: d, maximumFractionDigits: d});
  return v < 0 ? `(${s})` : s;
}

/** Compact money for axes: $1.2k, $15k. */
export function fk(v: number): string {
  if (Math.abs(v) < 1000) return fmt(v);
  const k = Math.abs(v) / 1000;
  return `${v < 0 ? '-' : ''}${currency}${k.toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k`;
}

/** Escapes text for HTML. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ESCAPES[ch]);
}

/** A round grid step that gives about five lines up to max. */
export function niceStep(max: number): number {
  const raw = max / 5;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Sum of numbers. */
export function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0);
}

/** Signed difference text: '+$5', '−$5' or '' when under half a unit. */
export function signed(d: number): string {
  if (Math.abs(d) < 0.5) return '';
  return (d > 0 ? '+' : '−') + fmt(Math.abs(d));
}
