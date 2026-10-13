import { expect, it } from "vitest";
import { automationFailure, classifyParserError, ParserFailure } from "./errors";

it.each([
  "Dateityp nicht erkannt",
  "Dieser Dateityp wird nicht unterstützt.",
  "Unsupported statement format",
  "Statement format not supported",
])("classifies browser unsupported-format errors permanently: %s", (message) => {
  const failure = classifyParserError(new Error(message));
  expect(failure.code).toBe("PARSE_UNSUPPORTED");
  expect(automationFailure(failure.code)).toMatchObject({
    code: "PARSE_UNSUPPORTED", retryable: false,
    message: expect.stringContaining("hochladen"),
  });
});

it("retains explicitly typed parser codes rather than guessing from private error text", () => {
  const failure = new ParserFailure("PARSE_RESOURCE_LIMIT", "unsupported private description");
  expect(classifyParserError(failure)).toBe(failure);
  expect(automationFailure(failure.code).message).not.toContain("private");
});

it("does not mistake missing local assets for unsupported statement input", () => {
  const failure = classifyParserError(Object.assign(
    new Error("Unsupported local module"), { code: "MODULE_NOT_FOUND" },
  ));
  expect(failure.code).toBe("PARSE_INFRASTRUCTURE");
  expect(automationFailure(failure.code).retryable).toBe(true);
});
