import fs from "node:fs";
import path from "node:path";

const VIRTUAL_ID = "virtual:falcondeck-extension-frontends";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

function repositoryRoot(configRoot) {
  let current = path.resolve(configRoot);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "extensions", "catalog.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("Could not find extensions/catalog.json");
}

function frontendEntries(root) {
  const extensionsRoot = path.join(root, "extensions");
  const catalogPath = path.join(extensionsRoot, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const entries = [];
  for (const item of catalog.packages ?? []) {
    const packageRoot = path.resolve(extensionsRoot, item.path);
    const relativePackageRoot = path.relative(extensionsRoot, packageRoot);
    if (
      relativePackageRoot.startsWith("..") ||
      path.isAbsolute(relativePackageRoot)
    ) {
      throw new Error(`Extension package escapes catalog root: ${item.path}`);
    }
    const manifestPath = path.join(packageRoot, "falcondeck.extension.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.frontend) continue;
    const frontendPath = path.resolve(packageRoot, manifest.frontend);
    const relativeFrontendPath = path.relative(packageRoot, frontendPath);
    if (
      relativeFrontendPath.startsWith("..") ||
      path.isAbsolute(relativeFrontendPath) ||
      !fs.statSync(frontendPath).isFile()
    ) {
      throw new Error(`Invalid frontend for extension ${manifest.id}`);
    }
    entries.push({
      id: manifest.id,
      manifestPath,
      frontendPath,
    });
  }
  return { catalogPath, entries };
}

/** Builds official trusted extension frontends as lazy application chunks. */
export function extensionFrontends() {
  let root = process.cwd();
  return {
    name: "falcondeck-extension-frontends",
    enforce: "pre",
    configResolved(config) {
      root = repositoryRoot(config.root);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      const { catalogPath, entries } = frontendEntries(root);
      this.addWatchFile(catalogPath);
      for (const entry of entries) {
        this.addWatchFile(entry.manifestPath);
        this.addWatchFile(entry.frontendPath);
      }
      const loaders = entries
        .map(
          (entry) =>
            `${JSON.stringify(entry.id)}: () => import(${JSON.stringify(entry.frontendPath)})`,
        )
        .join(",\n");
      return `export const extensionFrontendLoaders = {\n${loaders}\n};`;
    },
  };
}
