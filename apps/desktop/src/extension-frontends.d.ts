declare module "virtual:falcondeck-extension-frontends" {
  import type { ExtensionAppDefinition } from "@falcondeck/extension-sdk/app";

  export const extensionFrontendLoaders: Readonly<
    Partial<Record<string, () => Promise<{ default: ExtensionAppDefinition }>>>
  >;
}
