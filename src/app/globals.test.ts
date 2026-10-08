import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { expect, it } from "vitest";

it("keeps the global stylesheet valid CSS with its Tailwind imports and existing theme", () => {
  const filename = fileURLToPath(new URL("./globals.css", import.meta.url));
  const root = postcss.parse(readFileSync(filename, "utf8"), {
    from: filename,
  });
  const imports: string[] = [];
  const selectors: string[] = [];
  root.walkAtRules("import", (rule) => {
    imports.push(rule.params);
  });
  root.walkRules((rule) => {
    selectors.push(rule.selector);
  });

  expect(imports).toEqual(['"tailwindcss"', '"tw-animate-css"']);
  expect(selectors).toEqual(
    expect.arrayContaining([":root", ".dark", "body", ".panel"]),
  );
});

it("bounds the shimmer to the fill and disables it for system and application reduced motion", () => {
  const root = postcss.parse(
    readFileSync(new URL("./globals.css", import.meta.url), "utf8"),
  );
  const rules: postcss.Rule[] = [];
  root.walkRules((rule) => {
    rules.push(rule);
  });
  const shimmer = rules.find(
    (rule) =>
      rule.selector === ".automation-progress-shimmer::after" &&
      rule.parent?.type === "root",
  )!;
  const declarations = new Map(
    shimmer.nodes
      .filter((node) => node.type === "decl")
      .map((node) => [node.prop, node.value]),
  );
  expect(declarations.get("position")).toBe("absolute");
  expect(declarations.get("pointer-events")).toBe("none");
  expect(declarations.get("animation")).toContain("2.4s");
  const reduced = rules.filter(
    (rule) =>
      (rule.selector.includes('data-reduce-motion="true"') &&
        rule.selector.includes("automation-progress-shimmer")) ||
      (rule.selector === ".automation-progress-shimmer::after" &&
        rule.parent?.type === "atrule" &&
        rule.parent.name === "media" &&
        rule.parent.params === "(prefers-reduced-motion: reduce)"),
  );
  expect(reduced).toHaveLength(2);
  for (const rule of reduced)
    expect(
      rule.nodes.some(
        (node) =>
          node.type === "decl" &&
          node.prop === "animation" &&
          node.value === "none",
      ),
    ).toBe(true);
});
