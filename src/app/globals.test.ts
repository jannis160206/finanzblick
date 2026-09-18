import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { expect, it } from "vitest";

it("keeps the global stylesheet valid CSS with its Tailwind imports and existing theme", () => {
  const filename = fileURLToPath(new URL("./globals.css", import.meta.url));
  const root = postcss.parse(readFileSync(filename, "utf8"), { from: filename });
  const imports: string[] = [];
  const selectors: string[] = [];
  root.walkAtRules("import", (rule) => { imports.push(rule.params); });
  root.walkRules((rule) => { selectors.push(rule.selector); });

  expect(imports).toEqual(['"tailwindcss"', '"tw-animate-css"']);
  expect(selectors).toEqual(expect.arrayContaining([":root", ".dark", "body", ".panel"]));
});
