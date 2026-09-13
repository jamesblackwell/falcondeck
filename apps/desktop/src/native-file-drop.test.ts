import { describe, expect, it } from "vitest";

import { droppedAttachmentToFile } from "./native-file-drop";

describe("native file drop", () => {
  it("rebuilds a dropped file with its bytes intact", () => {
    const file = droppedAttachmentToFile({
      path: "/Users/james/Desktop/brief.pdf",
      name: "brief.pdf",
      mimeType: "application/pdf",
      dataBase64: btoa("pdf-bytes"),
    });

    expect(file.name).toBe("brief.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe("pdf-bytes".length);
  });

  it("types a dropped file from its name when the platform reports none", () => {
    const file = droppedAttachmentToFile({
      path: "/Users/james/Desktop/shot.png",
      name: "shot.png",
      mimeType: null,
      dataBase64: btoa("png"),
    });

    expect(file.type).toBe("image/png");
  });

  it("leaves an unknown extension untyped rather than guessing", () => {
    const file = droppedAttachmentToFile({
      path: "/Users/james/Desktop/notes.wat",
      name: "notes.wat",
      mimeType: null,
      dataBase64: btoa("wat"),
    });

    expect(file.type).toBe("");
  });
});
