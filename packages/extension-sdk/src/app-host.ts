import { useEffect, useMemo, useState } from "react";

import {
  collectExtensionApp,
  type ExtensionAppDefinition,
  type ExtensionAppRegistration,
} from "./app";

export type ExtensionFrontendLoader = () => Promise<{
  default: ExtensionAppDefinition;
}>;

export type ExtensionFrontendLoaders = Readonly<
  Partial<Record<string, ExtensionFrontendLoader>>
>;

export function useExtensionApps(
  enabledExtensionIds: readonly string[],
  loaders: ExtensionFrontendLoaders,
): ReadonlyMap<string, ExtensionAppRegistration> {
  const enabledKey = [...enabledExtensionIds].sort().join("\n");
  const ids = useMemo(
    () => (enabledKey ? enabledKey.split("\n") : []),
    [enabledKey],
  );
  const [registrations, setRegistrations] = useState<
    ReadonlyMap<string, ExtensionAppRegistration>
  >(() => new Map());

  useEffect(() => {
    let active = true;
    const candidates = ids.flatMap((extensionId) => {
      const load = loaders[extensionId];
      return load ? [{ extensionId, load }] : [];
    });
    void Promise.allSettled(
      candidates.map(async ({ extensionId, load }) => {
        const module = await load();
        const registration = collectExtensionApp(module.default);
        if (registration.extensionId !== extensionId) {
          throw new Error(
            `Extension frontend ${extensionId} registered as ${registration.extensionId}`,
          );
        }
        return registration;
      }),
    ).then((results) => {
      if (!active) return;
      const next = new Map<string, ExtensionAppRegistration>();
      for (const result of results) {
        if (result.status === "fulfilled") {
          next.set(result.value.extensionId, result.value);
        } else {
          console.error("Failed to load extension frontend", result.reason);
        }
      }
      setRegistrations(next);
    });
    return () => {
      active = false;
    };
  }, [ids, loaders]);

  return registrations;
}
