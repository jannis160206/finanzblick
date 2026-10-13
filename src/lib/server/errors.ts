// Database instances survive route-bundle boundaries and development reloads.
const accountErrorBrand = Symbol.for("finanzblick.account-error");
const configErrorBrand = Symbol.for("finanzblick.account-config-error");

export class AccountError extends Error {
  readonly [accountErrorBrand] = true;
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export class AccountConfigError extends AccountError {
  readonly [configErrorBrand] = true;
  constructor(message: string) {
    super(503, message);
    this.name = "AccountConfigError";
  }
}

export function isAccountError(error: unknown): error is AccountError {
  return error instanceof Error && accountErrorBrand in error && error[accountErrorBrand] === true;
}

export function isAccountConfigError(error: unknown): error is AccountConfigError {
  return isAccountError(error) && configErrorBrand in error && error[configErrorBrand] === true;
}

export function isSqliteContentionError(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ERR_SQLITE_ERROR" ||
    !("errcode" in error) ||
    typeof error.errcode !== "number" ||
    !Number.isSafeInteger(error.errcode) ||
    error.errcode < 0 ||
    error.errcode > 0x7fffffff
  ) return false;
  // SQLite extended result codes retain the primary result in the low byte.
  const primary = error.errcode & 0xff;
  return primary === 5 || primary === 6;
}
