import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./en.js";
import es from "./es.js";
import { resolveLocale } from "./index.js";

describe("i18n", () => {
  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["es", "es"],
    ["fr", "es"],
    ["fr, en;q=0.8", "en"],
    ["en;q=0, es;q=0.7", "es"],
    ["en;q=1.5", "es"],
    ["nonsense", "es"],
    [undefined, "es"],
  ])("resolves %s to %s", (header, expected) => {
    expect(resolveLocale({ headers: header ? { "accept-language": header } : {} })).toBe(expected);
  });

  it("keeps catalog keys and interpolation parameters in parity", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
    for (const key of Object.keys(es) as (keyof typeof es)[]) {
      const placeholders = (value: string) =>
        [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      expect(placeholders(en[key])).toEqual(placeholders(es[key]));
    }
  });

  it("has a translation in both catalogs for every source key", async () => {
    const files = await sourceFiles(join(process.cwd(), "src"));
    const used = new Set<string>();
    for (const file of files) {
      if (file.includes(`${join("src", "common", "i18n")}`)) continue;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/messageKey\("([^"]+)"\)/g)) used.add(match[1]!);
      for (const match of source.matchAll(/businessRule\("([^"]+)"/g)) used.add(match[1]!);
    }
    expect([...used].filter((key) => !(key in es) || !(key in en)).sort()).toEqual([]);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    }),
  );
  return files.flat();
}
