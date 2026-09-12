const currencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  useGrouping: "always",
});
export const currency = (value: number) => currencyFormatter.format(value);
export const number = (value: number, digits = 2) =>
  new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: "always",
  }).format(value);
export const percent = (value: number) =>
  new Intl.NumberFormat("de-AT", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
export const shortCurrency = (value: number) =>
  new Intl.NumberFormat("de-AT", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value) + " €";
export const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("de-AT", { timeZone: "UTC" }).format(
    new Date(`${value}T12:00:00Z`),
  );
export const monthLabel = (month: string, short = false) =>
  new Intl.DateTimeFormat("de-AT", {
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T12:00:00Z`));
