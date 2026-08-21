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
  "frontend",
  "contributes",
  "permissions",
]);
const contributionShapes = {
  threadMenuActions: { title: true, view: false, ui: false },
  threadDecorations: { title: false, view: true, ui: true },
  sidebarFilters: { title: true, view: true, ui: true },
  panels: { title: true, view: true, ui: true, icon: true },
  composerSuggestions: { title: false, view: true, ui: false },
  agentTools: { title: true, view: false, ui: false, tool: true },
};
const identifierPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const panelIcons = new Set([
  "activity",
  "blocks",
  "clock",
  "file-text",
  "kanban",
  "notebook",
  "notebook-pen",
  "sticky-note",
]);
const supportedPermissions = new Set([
  "threads:read",
  "agent-tools:register",
]);
const AGENT_TOOLS_PERMISSION = "agent-tools:register";
const uiTones = new Set([
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);
const uiGaps = new Set(["none", "small", "medium", "large"]);
const uiTextStyles = new Set(["body", "heading", "caption", "mono"]);
const uiButtonVariants = new Set(["secondary", "primary", "ghost", "danger"]);
const uiStateKinds = new Set(["loading", "empty", "error"]);
const unsafePathSegments = new Set(["__proto__", "constructor", "prototype"]);

function report(code, message, pointer = "") {
  diagnostics.push({ code, message, file: manifestPath, pointer });
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function validUiText(value, allowEmpty = true) {
  return (
    typeof value === "string" &&
    [...value].length <= 4096 &&
    (allowEmpty || value.trim().length > 0)
  );
}

function reportUi(pointer, message) {
  report("FDX1021", message, pointer);
  return false;
}

function validateUiNode(
  node,
  pointer,
  depth,
  counter,
  declaredActions,
  declaredViews,
) {
  counter.nodes += 1;
  if (depth > 32 || counter.nodes > 256) {
    return reportUi(pointer, "declarative UI exceeds 32 levels or 256 nodes");
  }
  if (!isObject(node) || typeof node.type !== "string") {
    return reportUi(
      pointer,
      "declarative UI node must be an object with a type",
    );
  }
  if (node.type === "stack" || node.type === "row") {
    const allowed =
      node.type === "row"
        ? ["type", "gap", "wrap", "children"]
        : ["type", "gap", "children"];
    if (
      !hasOnlyKeys(node, allowed) ||
      (node.gap !== undefined && !uiGaps.has(node.gap)) ||
      (node.type === "row" &&
        node.wrap !== undefined &&
        typeof node.wrap !== "boolean") ||
      !Array.isArray(node.children) ||
      node.children.length > 256
    ) {
      return reportUi(pointer, `invalid ${node.type} node`);
    }
    return node.children.every((child, index) =>
      validateUiNode(
        child,
        `${pointer}/children/${index}`,
        depth + 1,
        counter,
        declaredActions,
        declaredViews,
      ),
    );
  }
  if (node.type === "text") {
    return (
      (hasOnlyKeys(node, ["type", "text", "style", "tone"]) &&
        validUiText(node.text) &&
        (node.style === undefined || uiTextStyles.has(node.style)) &&
        (node.tone === undefined || uiTones.has(node.tone))) ||
      reportUi(pointer, "invalid text node")
    );
  }
  if (node.type === "badge") {
    return (
      (hasOnlyKeys(node, ["type", "text", "tone"]) &&
        validUiText(node.text) &&
        (node.tone === undefined || uiTones.has(node.tone))) ||
      reportUi(pointer, "invalid badge node")
    );
  }
  if (node.type === "divider") {
    return (
      hasOnlyKeys(node, ["type"]) || reportUi(pointer, "invalid divider node")
    );
  }
  if (node.type === "button") {
    const action = node.action;
    if (
      !hasOnlyKeys(node, ["type", "label", "action", "variant", "disabled"]) ||
      !validUiText(node.label, false) ||
      (node.variant !== undefined && !uiButtonVariants.has(node.variant)) ||
      (node.disabled !== undefined && typeof node.disabled !== "boolean") ||
      !isObject(action) ||
      !hasOnlyKeys(action, ["actionId", "input", "target"]) ||
      !identifierPattern.test(action.actionId ?? "") ||
      !declaredActions.has(action.actionId)
    ) {
      return reportUi(pointer, "invalid button or undeclared action binding");
    }
    if (
      action.target !== undefined &&
      (!isObject(action.target) ||
        !hasOnlyKeys(action.target, ["kind", "id"]) ||
        typeof action.target.kind !== "string" ||
        action.target.kind.length === 0 ||
        [...action.target.kind].length > 64 ||
        typeof action.target.id !== "string" ||
        action.target.id.length === 0 ||
        [...action.target.id].length > 512)
    ) {
      return reportUi(`${pointer}/action/target`, "invalid action target");
    }
    if (
      action.input !== undefined &&
      Buffer.byteLength(JSON.stringify(action.input)) > 64 * 1024
    ) {
      return reportUi(
        `${pointer}/action/input`,
        "action input exceeds 65536 bytes",
      );
    }
    return true;
  }
  if (node.type === "list") {
    if (
      !hasOnlyKeys(node, ["type", "items"]) ||
      !Array.isArray(node.items) ||
      node.items.length > 256
    ) {
      return reportUi(pointer, "invalid list node");
    }
    return node.items.every((item, index) =>
      validateUiNode(
        item,
        `${pointer}/items/${index}`,
        depth + 1,
        counter,
        declaredActions,
        declaredViews,
      ),
    );
  }
  if (node.type === "select") {
    const binding = node.binding;
    const values = new Set();
    const validOptions =
      Array.isArray(node.options) &&
      node.options.length <= 256 &&
      node.options.every((option) => {
        if (
          !isObject(option) ||
          !hasOnlyKeys(option, ["value", "label", "tone"]) ||
          typeof option.value !== "string" ||
          option.value.length === 0 ||
          [...option.value].length > 256 ||
          values.has(option.value) ||
          !validUiText(option.label, false) ||
          (option.tone !== undefined && !uiTones.has(option.tone))
        )
          return false;
        values.add(option.value);
        return true;
      });
    const validBinding =
      isObject(binding) &&
      hasOnlyKeys(binding, ["view", "path", "operator"]) &&
      identifierPattern.test(binding.view ?? "") &&
      declaredViews.has(binding.view) &&
      binding.operator === "includes_any" &&
      Array.isArray(binding.path) &&
      binding.path.length > 0 &&
      binding.path.length <= 16 &&
      binding.path.every(
        (segment) =>
          typeof segment === "string" &&
          segment.length > 0 &&
          [...segment].length <= 128 &&
          !unsafePathSegments.has(segment),
      );
    return (
      (hasOnlyKeys(node, [
        "type",
        "id",
        "label",
        "multiple",
        "options",
        "binding",
      ]) &&
        identifierPattern.test(node.id ?? "") &&
        validUiText(node.label, false) &&
        (node.multiple === undefined || typeof node.multiple === "boolean") &&
        validOptions &&
        validBinding) ||
      reportUi(pointer, "invalid select or thread-filter binding")
    );
  }
  if (node.type === "state") {
    return (
      (hasOnlyKeys(node, ["type", "state", "title", "description"]) &&
        uiStateKinds.has(node.state) &&
        validUiText(node.title, false) &&
        (node.description === undefined || validUiText(node.description))) ||
      reportUi(pointer, "invalid state node")
    );
  }
  return reportUi(pointer, `unsupported declarative UI node: ${node.type}`);
}

function validateUiDocument(
  document,
  pointer,
  declaredActions,
  declaredViews,
  requireSelectRoot,
) {
  if (
    !isObject(document) ||
    !hasOnlyKeys(document, ["version", "root"]) ||
    document.version !== 1
  ) {
    return reportUi(pointer, "declarative UI must use version 1");
  }
  if (requireSelectRoot && document.root?.type !== "select") {
    return reportUi(
      `${pointer}/root`,
      "sidebar filter UI must use a select root",
    );
  }
  return validateUiNode(
    document.root,
    `${pointer}/root`,
    1,
    { nodes: 0 },
    declaredActions,
    declaredViews,
  );
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
  if (manifest.frontend !== undefined) {
    const rawFrontend = manifest.frontend;
    if (typeof rawFrontend !== "string" || !rawFrontend) {
      report(
        "FDX1022",
        "frontend must stay inside the extension package",
        "/frontend",
      );
    } else {
      const frontend = resolve(root, rawFrontend);
      const frontendRelative = relative(root, frontend);
      if (
        frontendRelative.startsWith(`..${sep}`) ||
        frontendRelative === ".." ||
        /^[A-Za-z]:[\\/]/.test(rawFrontend) ||
        rawFrontend.startsWith("\\\\")
      ) {
        report(
          "FDX1022",
          "frontend must stay inside the extension package",
          "/frontend",
        );
      } else {
        try {
          const frontendStat = await stat(frontend);
          if (!frontendStat.isFile()) {
            report("FDX1023", "frontend is not a file", "/frontend");
          }
        } catch {
          report("FDX1023", "frontend does not exist", "/frontend");
        }
      }
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
  const declaredActions = new Set();
  const declaredViews = new Set();
  const uiDocuments = [];
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
        ...(shape.ui ? ["ui"] : []),
        ...(shape.icon ? ["icon"] : []),
        ...(shape.tool ? ["description", "inputSchema"] : []),
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
        if (key === "threadMenuActions") declaredActions.add(id);
      }
      const titleLimit = shape.tool ? 60 : 80;
      if (
        shape.title &&
        (typeof contribution.title !== "string" ||
          contribution.title.trim().length === 0 ||
          [...contribution.title].length > titleLimit)
      ) {
        report(
          "FDX1016",
          `title must contain 1–${titleLimit} characters`,
          `/contributes/${key}/${index}/title`,
        );
      }
      if (shape.tool) {
        if (
          typeof contribution.description !== "string" ||
          contribution.description.trim().length < 16 ||
          [...contribution.description].length > 1024
        ) {
          report(
            "FDX1024",
            "agent tool description must contain 16–1024 characters",
            `/contributes/${key}/${index}/description`,
          );
        }
        if (
          !isObject(contribution.inputSchema) ||
          contribution.inputSchema.type !== "object"
        ) {
          report(
            "FDX1025",
            "agent tool inputSchema must describe a JSON object",
            `/contributes/${key}/${index}/inputSchema`,
          );
        } else if (
          new TextEncoder().encode(JSON.stringify(contribution.inputSchema))
            .byteLength > 8192
        ) {
          report(
            "FDX1025",
            "agent tool inputSchema exceeds 8192 bytes",
            `/contributes/${key}/${index}/inputSchema`,
          );
        }
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
      } else if (shape.view) {
        declaredViews.add(contribution.view);
      }
      if (
        shape.icon &&
        contribution.icon !== undefined &&
        !panelIcons.has(contribution.icon)
      ) {
        report(
          "FDX1023",
          "panel icon must be a host-owned icon name",
          `/contributes/${key}/${index}/icon`,
        );
      }
      if (shape.ui && contribution.ui !== undefined) {
        uiDocuments.push({
          document: contribution.ui,
          pointer: `/contributes/${key}/${index}/ui`,
          requireSelectRoot: key === "sidebarFilters",
        });
      }
    }
  }
  for (const ui of uiDocuments) {
    validateUiDocument(
      ui.document,
      ui.pointer,
      declaredActions,
      declaredViews,
      ui.requireSelectRoot,
    );
  }
  if (
    (contributes?.agentTools?.length ?? 0) > 0 &&
    !(manifest.permissions ?? []).includes(AGENT_TOOLS_PERMISSION)
  ) {
    report(
      "FDX1026",
      `extensions contributing agentTools must declare the ${AGENT_TOOLS_PERMISSION} permission`,
      "/permissions",
    );
  }
  if ((contributes?.agentTools?.length ?? 0) > 8) {
    report(
      "FDX1027",
      "manifest cannot declare more than 8 agent tools",
      "/contributes/agentTools",
    );
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
  } else {
    if (manifest.permissions.length > 16) {
      report("FDX1008", "permissions exceed the 16-item limit", "/permissions");
    }
    const seenPermissions = new Set();
    for (let index = 0; index < manifest.permissions.length; index += 1) {
      const permission = manifest.permissions[index];
      if (
        typeof permission !== "string" ||
        !supportedPermissions.has(permission)
      ) {
        report(
          "FDX1018",
          `unsupported permission: ${String(permission)}`,
          `/permissions/${index}`,
        );
      } else if (seenPermissions.has(permission)) {
        report(
          "FDX1008",
          `duplicate permission: ${permission}`,
          `/permissions/${index}`,
        );
      }
      seenPermissions.add(permission);
    }
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
