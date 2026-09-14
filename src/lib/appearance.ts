export const defaultAccentColor = "#5bddad";
export const accentSwatches = [
  { label: "Mint", color: "#5bddad" },
  { label: "Blau", color: "#60a5fa" },
  { label: "Violett", color: "#a78bfa" },
  { label: "Rose", color: "#fb7185" },
  { label: "Gold", color: "#e5b85c" },
  { label: "Türkis", color: "#2dd4bf" },
] as const;

// Self-contained: also used by the pre-paint bootstrap before React loads.
export function accentTokens(input?: string) {
  const color =
    typeof input === "string" && /^#[\da-f]{6}$/i.test(input)
      ? input.toLowerCase()
      : "#5bddad";
  const channels = (hex: string) =>
    [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const luminance = (hex: string) =>
    channels(hex)
      .map((channel) => {
        const n = channel / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, n, index) => sum + n * [0.2126, 0.7152, 0.0722][index], 0);
  const ratio = (a: string, b: string) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
    return (values[1] + 0.05) / (values[0] + 0.05);
  };
  const mix = (target: number, amount: number) =>
    "#" +
    channels(color)
      .map((n) =>
        Math.round(n + (target - n) * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const readable = (background: string, target: number) => {
    for (let step = 0; step <= 100; step++) {
      const candidate = mix(target, step / 100);
      if (ratio(candidate, background) >= 5) return candidate;
    }
    return mix(target, 1);
  };
  const onAccent =
    ratio(color, "#000000") >= ratio(color, "#ffffff") ? "#000000" : "#ffffff";
  return {
    "--user-accent": color,
    "--user-accent-foreground": onAccent,
    "--user-accent-hover": mix(onAccent === "#000000" ? 255 : 0, 0.08),
    "--user-accent-light": readable("#f5f7f6", 0),
    "--user-accent-dark": readable("#272e2b", 255),
  };
}
