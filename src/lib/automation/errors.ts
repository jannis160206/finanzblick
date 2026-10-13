import { z } from "zod";

export const automationErrorCodeSchema = z.enum([
  "PARSE_DAMAGED",
  "PARSE_ENCRYPTED",
  "PARSE_UNSUPPORTED",
  "PARSE_RESOURCE_LIMIT",
  "PARSE_TIMEOUT",
  "PARSE_INFRASTRUCTURE",
  "COMMIT_CONFLICT",
  "WORKER_ABORTED",
  "WORKER_INTERRUPTED",
]);
export type AutomationErrorCode = z.infer<typeof automationErrorCodeSchema>;
export type AutomationFailure = {
  code: AutomationErrorCode;
  message: string;
  retryable: boolean;
};

const messages: Record<AutomationErrorCode, string> = {
  PARSE_DAMAGED: "Die Datei ist beschädigt oder ungültig. Bitte einen neuen Kontoauszug exportieren und hochladen.",
  PARSE_ENCRYPTED: "Die PDF-Datei ist passwortgeschützt. Bitte eine unverschlüsselte Kopie hochladen.",
  PARSE_UNSUPPORTED: "Dieses Auszugsformat wird nicht unterstützt. Bitte CSV, XLSX oder einen unterstützten Amex-Auszug hochladen.",
  PARSE_RESOURCE_LIMIT: "Die Datei überschreitet ein Verarbeitungslimit. Bitte einen kleineren Auszug oder Screenshot hochladen.",
  PARSE_TIMEOUT: "Die Verarbeitung wurde nach dem Zeitlimit abgebrochen. Bitte einen kleineren Auszug oder Screenshot hochladen.",
  PARSE_INFRASTRUCTURE: "Die lokale Verarbeitung ist vorübergehend nicht verfügbar. Es folgen höchstens fünf Versuche; bei erneutem Fehler bitte den lokalen Dienst prüfen.",
  COMMIT_CONFLICT: "Der Finanzstand wurde während des Imports geändert. Deine Änderung bleibt erhalten; der Import wird mit dem aktuellen Stand erneut versucht.",
  WORKER_ABORTED: "Die Verarbeitung wurde beim Stoppen des Workers abgebrochen und wird nach dem Neustart fortgesetzt.",
  WORKER_INTERRUPTED: "Der Worker wurde unterbrochen. Die Verarbeitung wird mit begrenzten Wiederholungen fortgesetzt.",
};

export function automationFailure(code: AutomationErrorCode): AutomationFailure {
  return {
    code,
    message: messages[code],
    retryable: code === "PARSE_INFRASTRUCTURE" || code === "WORKER_INTERRUPTED" || code === "COMMIT_CONFLICT",
  };
}

export class ParserFailure extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(detail ?? messages[code], options);
    this.name = "ParserFailure";
  }
}

export function classifyParserError(error: unknown): ParserFailure {
  if (error instanceof ParserFailure) return error;
  const record = error as { code?: string; name?: string; message?: string } | null;
  const message = typeof record?.message === "string" ? record.message : "";
  let code: AutomationErrorCode = "PARSE_DAMAGED";
  if (record?.name === "PasswordException" || /password|encrypted|verschlüsselt/i.test(message))
    code = "PARSE_ENCRYPTED";
  else if (/timeout|timed out|zeitlimit/i.test(message))
    code = "PARSE_TIMEOUT";
  else if (record?.code === "ENOMEM")
    code = "PARSE_RESOURCE_LIMIT";
  else if (/EIO|EBUSY|EMFILE|ENFILE|ENOENT|EACCES|MODULE_NOT_FOUND/.test(record?.code ?? "") ||
    /worker unavailable|worker.*initializ|language.*load/i.test(message))
    code = "PARSE_INFRASTRUCTURE";
  else if (/dateityp.*nicht erkannt|nicht unterstützt|unsupported|not supported/i.test(message))
    code = "PARSE_UNSUPPORTED";
  else if (/pixel limit|too many|zu viele|zu viel|höchstens|limit|out of memory/i.test(message))
    code = "PARSE_RESOURCE_LIMIT";
  return new ParserFailure(code, message || undefined, { cause: error });
}
