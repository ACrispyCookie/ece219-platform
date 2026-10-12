// Decimal arithmetic uses scaled integers, never binary floating point.
export function parseDecimal(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value) || value.length > 200)
    throw new Error('Χρησιμοποιήστε μη αρνητικό δεκαδικό αριθμό με τελεία.');
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
export function compareDecimal(a: string, b: string) {
  const x = parseDecimal(a),
    y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const difference =
    x.units * 10n ** BigInt(scale - x.scale) - y.units * 10n ** BigInt(scale - y.scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function sumDecimals(values: string[]) {
  const numbers = values.map(parseDecimal);
  const scale = Math.max(0, ...numbers.map((x) => x.scale));
  const units = numbers.reduce((sum, x) => sum + x.units * 10n ** BigInt(scale - x.scale), 0n);
  const digits = units.toString().padStart(scale + 1, '0');
  return scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '')
    : digits;
}
