const roundCents = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Parses an Austrian/German money string into euros rounded to cents.
 * `1.500` is 1500 (thousands separator), `1,5` is 1.5, `1.5` and `1.50` keep
 * their decimal point, `(12,00)` and `12,00-` are negative. Anything that is
 * not unambiguously a money amount yields null instead of a guess.
 */
export function parseMoneyText(raw: string | number): number | null {
  if (typeof raw === "number")
    return Number.isFinite(raw) ? roundCents(raw) : null;
  let text = raw
    .trim()
    .replace(/\u2212/g, "-")
    .replace(/(?:EUR|€)/gi, "")
    .replace(/[\s\u00a0']/g, "");
  if (!text || !/^[+\-]?(?:\d[\d.,]*\d|\d)[-]?$|^\(\d[\d.,]*\)$/.test(text))
    return null;
  let sign = 1;
  if (text.startsWith("(") && text.endsWith(")")) {
    sign = -1;
    text = text.slice(1, -1);
  }
  if (text.endsWith("-")) {
    sign = -1;
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    sign *= -1;
    text = text.slice(1);
  }
  text = text.replace(/^\+/, "");
  if (text.includes(",")) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(text)) return null;
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  else if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text) * sign;
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000
    ? roundCents(value)
    : null;
}
