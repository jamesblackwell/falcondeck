type MermaidAssetLoader = () => Promise<string>;

let loadAsset: MermaidAssetLoader = loadBundledMermaidSource;
let cache: Promise<string> | null = null;

async function loadBundledMermaidSource(): Promise<string> {
  const [{ Asset }, { File }, assetModule] = await Promise.all([
    import("expo-asset"),
    import("expo-file-system"),
    import("./mermaidAsset"),
  ]);
  const asset = Asset.fromModule(assetModule.default);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error("Mermaid engine is unavailable");
  }
  return new File(asset.localUri).text();
}

/** Test seam: swap the engine source without touching the bundled asset. */
export function setMermaidAssetLoader(loader: MermaidAssetLoader | null) {
  loadAsset = loader ?? loadBundledMermaidSource;
  cache = null;
}

export function loadMermaidBrowserSource(): Promise<string> {
  if (!cache) {
    // A rejected promise must not be cached, or one failed read would leave
    // every later diagram in this session stuck on the source fallback.
    cache = loadAsset().catch((error) => {
      cache = null;
      throw error;
    });
  }
  return cache;
}
