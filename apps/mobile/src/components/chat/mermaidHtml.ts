import {
  mermaidRenderOptions,
  type MermaidPalette,
} from "@falcondeck/client-core";

export type MermaidWebViewMessage =
  | { type: "ready"; height: number }
  | { type: "error"; message: string };

export function inlineMermaidScript(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1");
}

export function parseMermaidWebViewMessage(
  data: string,
): MermaidWebViewMessage | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object") return null;
    const message = parsed as { type?: unknown; height?: unknown; message?: unknown };
    if (message.type === "ready" && typeof message.height === "number") {
      return { type: "ready", height: Math.max(1, message.height) };
    }
    if (message.type === "error") {
      return {
        type: "error",
        message: typeof message.message === "string" ? message.message : "Could not render diagram",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildMermaidDocument(options: {
  source: string;
  mermaidScript: string;
  palette: MermaidPalette;
}): string {
  const config = mermaidRenderOptions(options.palette);
  const background = options.palette.background || "transparent";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<style>
  html, body { margin: 0; padding: 0; background: ${background}; }
  #diagram { overflow: hidden; }
  svg { max-width: 100%; height: auto; display: block; }
</style>
</head>
<body>
<div id="diagram"></div>
<script>${inlineMermaidScript(options.mermaidScript)}</script>
<script>
(function () {
  var source = ${JSON.stringify(options.source)};
  var config = ${JSON.stringify(config)};
  function post(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }
  function publishHeight() {
    var height = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body.scrollHeight || 0,
    );
    post({ type: "ready", height: height });
  }
  try {
    mermaid.initialize(config);
    mermaid.render("fd-mermaid", source).then(function (result) {
      document.getElementById("diagram").innerHTML = result.svg;
      requestAnimationFrame(publishHeight);
    }).catch(function (error) {
      post({ type: "error", message: String(error && error.message || error) });
    });
  } catch (error) {
    post({ type: "error", message: String(error && error.message || error) });
  }
})();
</script>
</body>
</html>`;
}
