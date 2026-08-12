import { readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

const target = resolve(process.argv[2] ?? "extensions/official/thread-tags");
const manifestPath = (await stat(target)).isDirectory()
  ? resolve(target, "falcondeck.extension.json")
  : target;
const root = resolve(manifestPath, "..");
const diagnostics = [];
const allowedTopLevelKeys = new Set([
  "$schema",
  "id",
  "name",
  "version",
  "engines",
  "entrypoint",
  "contributes",
  "permissions",
]);
const contributionShapes = {
  threadMenuActions: { title: true, view: false },
  threadDecorations: { title: false, view: true },
  sidebarFilters: { title: true, view: true },
};

function report(code, message, pointer = "") {
  diagnostics.push({ code, message, file: manifestPath, pointer });
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  report("FDX1000", error instanceof Error ? error.message : String(error));
}

if (manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    report("FDX1009", "manifest must be a JSON object");
  }
  for (const key of Object.keys(manifest)) {
    if (!allowedTopLevelKeys.has(key)) {
      report("FDX1010", `unknown manifest property: ${key}`, `/${key}`);
    }
  }
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id ?? "")) {
    report("FDX1001", "id must be a stable dotted identifier", "/id");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    report("FDX1002", "version must be semantic version syntax", "/version");
  }
  if (!/^\^?0\.1(?:\.\d+)?$/.test(manifest.engines?.falcondeck ?? "")) {
    report(
      "FDX1003",
      "engines.falcondeck must target the 0.1 extension API",
      "/engines/falcondeck",
    );
  }
  const rawEntrypoint = manifest.entrypoint ?? "";
  const entrypoint = resolve(root, rawEntrypoint);
  const rel = relative(root, entrypoint);
  if (
    !rawEntrypoint ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    /^[A-Za-z]:[\\/]/.test(rawEntrypoint) ||
    rawEntrypoint.startsWith("\\\\")
  ) {
    report(
      "FDX1004",
      "entrypoint must stay inside the extension package",
      "/entrypoint",
    );
  } else {
    try {
      const entrypointStat = await stat(entrypoint);
      if (!entrypointStat.isFile()) {
        report("FDX1005", "entrypoint is not a file", "/entrypoint");
      }
    } catch {
      report("FDX1005", "entrypoint does not exist", "/entrypoint");
    }
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.trim().length === 0 ||
    [...manifest.name].length > 80
  ) {
    report("FDX1011", "name must contain 1–80 characters", "/name");
  }
  const ids = new Set();
  let contributionCount = 0;
  const contributes = manifest.contributes;
  if (
    !contributes ||
    typeof contributes !== "object" ||
    Array.isArray(contributes)
  ) {
    report("FDX1012", "contributes must be an object", "/contributes");
  }
  for (const key of Object.keys(contributes ?? {})) {
    if (!(key in contributionShapes)) {
      report(
        "FDX1013",
        `unknown contribution point: ${key}`,
        `/contributes/${key}`,
      );
    }
  }
  for (const [key, shape] of Object.entries(contributionShapes)) {
    const values = contributes?.[key] ?? [];
    if (!Array.isArray(values)) {
      report("FDX1014", `${key} must be an array`, `/contributes/${key}`);
      continue;
    }
    contributionCount += values.length;
    for (let index = 0; index < values.length; index += 1) {
      const contribution = values[index];
      if (
        !contribution ||
        typeof contribution !== "object" ||
        Array.isArray(contribution)
      ) {
        report(
          "FDX1015",
          "contribution must be an object",
          `/contributes/${key}/${index}`,
        );
        continue;
      }
      const allowedKeys = new Set([
        "id",
        ...(shape.title ? ["title"] : []),
        ...(shape.view ? ["view"] : []),
      ]);
      for (const property of Object.keys(contribution)) {
        if (!allowedKeys.has(property)) {
          report(
            "FDX1019",
            `unknown contribution property: ${property}`,
            `/contributes/${key}/${index}/${property}`,
          );
        }
      }
      const id = values[index]?.id;
      if (
        typeof id !== "string" ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)
      ) {
        report(
          "FDX1006",
          "contribution id must be kebab-case",
          `/contributes/${key}/${index}/id`,
        );
      } else if (ids.has(id)) {
        report(
          "FDX1007",
          `duplicate contribution id: ${id}`,
          `/contributes/${key}/${index}/id`,
        );
      } else {
        ids.add(id);
      }
      if (
        shape.title &&
        (typeof contribution.title !== "string" ||
          contribution.title.trim().length === 0 ||
          [...contribution.title].length > 80)
      ) {
        report(
          "FDX1016",
          "title must contain 1–80 characters",
          `/contributes/${key}/${index}/title`,
        );
      }
      if (
        shape.view &&
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(contribution.view ?? "")
      ) {
        report(
          "FDX1017",
          "view must be a kebab-case identifier",
          `/contributes/${key}/${index}/view`,
        );
      }
    }
  }
  if (contributionCount > 256) {
    report(
      "FDX1020",
      "manifest cannot declare more than 256 contributions",
      "/contributes",
    );
  }
  if (!Array.isArray(manifest.permissions)) {
    report("FDX1008", "permissions must be an array", "/permissions");
  } else if (manifest.permissions.length > 0) {
    report(
      "FDX1018",
      "permissions are not supported by this FalconDeck version",
      "/permissions",
    );
  }
}

const output = { ok: diagnostics.length === 0, diagnostics };
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else if (output.ok) {
  process.stdout.write(`Valid FalconDeck extension: ${manifestPath}\n`);
} else {
  for (const diagnostic of diagnostics) {
    process.stderr.write(
      `${diagnostic.code} ${diagnostic.file}${diagnostic.pointer}: ${diagnostic.message}\n`,
    );
  }
}
process.exitCode = output.ok ? 0 : 1;
