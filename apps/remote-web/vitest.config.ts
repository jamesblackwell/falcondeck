import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { extensionFrontends } from "../../scripts/vite-extension-frontends.mjs";

export default defineConfig({
  plugins: [extensionFrontends(), react()],
  // The shared packages have no tsconfig of their own, so esbuild would fall
  // back to the classic JSX runtime (requiring a React import) for them.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    // Node 26 ships an experimental localStorage global that is undefined
    // without --localstorage-file; it shadows jsdom's real localStorage when
    // vitest populates globals. Turn it off so window.localStorage works.
    poolOptions: {
      threads: { execArgv: ["--no-experimental-webstorage"] },
      forks: { execArgv: ["--no-experimental-webstorage"] },
    },
  },
});
