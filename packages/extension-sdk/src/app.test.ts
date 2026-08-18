import { describe, expect, it } from "vitest";

import { collectExtensionApp, defineExtensionApp } from "./app";

function Panel() {
  return null;
}

describe("extension app registrations", () => {
  it("collects a typed panel for its declared extension identity", () => {
    const registration = collectExtensionApp(
      defineExtensionApp("example.kanban", (app) => {
        app.panels.register({
          id: "board",
          title: "Board",
          component: Panel,
        });
      }),
    );

    expect(registration.extensionId).toBe("example.kanban");
    expect(registration.panels).toEqual([
      expect.objectContaining({ id: "board", title: "Board" }),
    ]);
  });

  it("rejects duplicate panel ids before the host mounts either component", () => {
    const definition = defineExtensionApp("example.kanban", (app) => {
      app.panels.register({ id: "board", title: "One", component: Panel });
      app.panels.register({ id: "board", title: "Two", component: Panel });
    });

    expect(() => collectExtensionApp(definition)).toThrow(
      "Invalid or duplicate extension panel id: board",
    );
  });
});
