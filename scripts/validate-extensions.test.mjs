import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-extensions.mjs");

function validate(target) {
  const result = spawnSync(process.execPath, [validator, target, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: JSON.parse(result.stdout),
  };
}

test("official Thread Colours declarative UI validates", () => {
  const result = validate(
    resolve(repositoryRoot, "extensions/official/thread-tags"),
  );

  assert.equal(result.status, 0);
  assert.deepEqual(result.output, { ok: true, diagnostics: [] });
});

test("official Mini Zen panel declarative UI validates", () => {
  const result = validate(
    resolve(repositoryRoot, "extensions/official/mini-zen"),
  );

  assert.equal(result.status, 0);
  assert.deepEqual(result.output, { ok: true, diagnostics: [] });
});

test("newer declarative UI versions fail with a stable diagnostic", () => {
  const directory = mkdtempSync(
    resolve(tmpdir(), "falcondeck-extension-validator-"),
  );
  try {
    writeFileSync(resolve(directory, "server.ts"), "export default {}\n");
    writeFileSync(
      resolve(directory, "falcondeck.extension.json"),
      JSON.stringify({
        id: "example.extension",
        name: "Example",
        version: "1.0.0",
        engines: { falcondeck: "^0.1" },
        entrypoint: "server.ts",
        contributes: {
          sidebarFilters: [
            {
              id: "future",
              title: "Future",
              view: "future",
              ui: { version: 2, root: { type: "divider" } },
            },
          ],
        },
        permissions: [],
      }),
    );

    const result = validate(directory);

    assert.equal(result.status, 1);
    assert.equal(result.output.diagnostics[0]?.code, "FDX1021");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("panels require a durable title and view id", () => {
  const directory = mkdtempSync(
    resolve(tmpdir(), "falcondeck-extension-validator-"),
  );
  try {
    writeFileSync(resolve(directory, "server.ts"), "export default {}\n");
    writeFileSync(
      resolve(directory, "falcondeck.extension.json"),
      JSON.stringify({
        id: "example.panel",
        name: "Example",
        version: "1.0.0",
        engines: { falcondeck: "^0.1" },
        entrypoint: "server.ts",
        contributes: {
          panels: [{ id: "main", view: "main-panel" }],
        },
        permissions: [],
      }),
    );

    const result = validate(directory);

    assert.equal(result.status, 1);
    assert.equal(result.output.diagnostics[0]?.code, "FDX1016");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
