import { useMemo, useState } from "react";

import type { ExtensionSnapshot } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  MainViewLead,
  SearchField,
  SettingsPage,
  SettingsPageHeader,
} from "@falcondeck/ui";

function permissionPresentation(permission: string) {
  if (permission === "threads:read") {
    return {
      title: "Read thread summaries",
      description:
        "Allows titles, providers, status, timestamps, and pending-request counts. Messages and transcripts stay private.",
    };
  }
  if (permission === "agent-tools:register") {
    return {
      title: "Offer tools to agents",
      description:
        "Publishes this extension's declared tools to agents running in FalconDeck. Revoking removes them from the next agent session and fails any call in the meantime.",
    };
  }
  if (permission === "automations:manage-owned") {
    return {
      title: "Manage owned automations",
      description:
        "Create and control scheduled agent check-ins that belong to this extension. It cannot change standalone automations or automations owned by another extension.",
    };
  }
  return { title: permission, description: "Requested extension capability." };
}

const EXTENSIONS_DESCRIPTION =
  "Manage extensions installed on this FalconDeck. Official extensions are built and maintained by FalconDeck.";

export function ExtensionsPanel({
  extensions,
  onSetEnabled,
  onSetPermission,
  chrome = "settings",
}: {
  extensions: ExtensionSnapshot;
  onSetEnabled: (extensionId: string, enabled: boolean) => Promise<void>;
  onSetPermission: (
    extensionId: string,
    permission: string,
    granted: boolean,
  ) => Promise<void>;
  /** `host` when this panel is a top-level main view; chrome already titles it. */
  chrome?: "settings" | "host";
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingExtensions = useMemo(
    () =>
      extensions.catalog
        .filter((extension) => {
          if (!normalizedQuery) return true;
          return [
            extension.name,
            extension.id,
            extension.source,
            extension.bundled ? "official" : "",
          ].some((value) =>
            value.toLocaleLowerCase().includes(normalizedQuery),
          );
        })
        .toSorted(
          (left, right) =>
            Number(right.enabled) - Number(left.enabled) ||
            left.name.localeCompare(right.name),
        ),
    [extensions.catalog, normalizedQuery],
  );

  const update = async (extensionId: string, enabled: boolean) => {
    setPendingKey(`extension:${extensionId}`);
    setError(null);
    try {
      await onSetEnabled(extensionId, enabled);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update extension",
      );
    } finally {
      setPendingKey(null);
    }
  };

  const updatePermission = async (
    extensionId: string,
    permission: string,
    granted: boolean,
  ) => {
    setPendingKey(`permission:${extensionId}:${permission}`);
    setError(null);
    try {
      await onSetPermission(extensionId, permission, granted);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update permission",
      );
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <SettingsPage className={chrome === "host" ? "pb-0" : undefined}>
      {chrome === "settings" ? (
        <SettingsPageHeader
          title="Extensions"
          description={EXTENSIONS_DESCRIPTION}
        />
      ) : (
        <MainViewLead>{EXTENSIONS_DESCRIPTION}</MainViewLead>
      )}
      <SearchField
        label="Search installed extensions"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search installed extensions"
      />
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}
      <div className="space-y-3">
        {matchingExtensions.map((extension, index) => {
          const unsupportedContributions =
            extension.contributes.unsupported ?? [];
          const startsDisabledSection =
            !extension.enabled &&
            (index === 0 || matchingExtensions[index - 1]?.enabled);
          return (
            <div key={extension.id}>
              {startsDisabledSection ? (
                <h2 className="fd-type-eyebrow mb-2 mt-6 text-fg-muted">
                  Disabled
                </h2>
              ) : index === 0 && extension.enabled ? (
                <h2 className="fd-type-eyebrow mb-2 text-fg-muted">Enabled</h2>
              ) : null}
              <section className="rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-medium text-fg-primary">
                        {extension.name}
                      </h2>
                      {extension.bundled ? (
                        <Badge title="Built and maintained by FalconDeck">
                          Official
                        </Badge>
                      ) : null}
                      <Badge
                        variant={
                          extension.status === "error"
                            ? "danger"
                            : extension.enabled
                              ? "success"
                              : "default"
                        }
                      >
                        {extension.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                      {extension.id} · v{extension.version} · {extension.source}
                    </p>
                    {extension.permissions.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                          Requested permissions
                        </p>
                        {extension.permissions.map((permission) => {
                          const granted = (
                            extension.granted_permissions ?? []
                          ).includes(permission);
                          const presentation =
                            permissionPresentation(permission);
                          const permissionKey = `permission:${extension.id}:${permission}`;
                          return (
                            <div
                              key={permission}
                              className="flex items-center justify-between gap-4 rounded-[var(--fd-radius-md)] bg-surface-1 px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="text-[length:var(--fd-text-sm)] text-fg-primary">
                                    {presentation.title}
                                  </p>
                                  <code className="text-[length:var(--fd-text-xs)] text-fg-muted">
                                    {permission}
                                  </code>
                                  <Badge
                                    variant={granted ? "success" : "default"}
                                  >
                                    {granted ? "Granted" : "Not granted"}
                                  </Badge>
                                </div>
                                <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                                  {presentation.description}
                                </p>
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={pendingKey !== null}
                                onClick={() =>
                                  void updatePermission(
                                    extension.id,
                                    permission,
                                    !granted,
                                  )
                                }
                                aria-label={`${granted ? "Revoke" : "Grant"} ${permission} for ${extension.name}`}
                              >
                                {pendingKey === permissionKey ? (
                                  <ActivityDiamond size="sm" />
                                ) : granted ? (
                                  "Revoke"
                                ) : (
                                  "Grant"
                                )}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {extension.last_error ? (
                      <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
                        {extension.last_error}
                      </p>
                    ) : null}
                    {unsupportedContributions.length > 0 ? (
                      <p
                        role="status"
                        className="mt-2 text-[length:var(--fd-text-xs)] text-warning"
                      >
                        This FalconDeck client cannot render:{" "}
                        {unsupportedContributions
                          .map((contribution) => contribution.kind)
                          .join(", ")}
                        .
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pendingKey !== null}
                    onClick={() =>
                      void update(extension.id, !extension.enabled)
                    }
                  >
                    {pendingKey === `extension:${extension.id}` ? (
                      <ActivityDiamond size="sm" />
                    ) : extension.enabled ? (
                      "Disable"
                    ) : (
                      "Enable"
                    )}
                  </Button>
                </div>
              </section>
            </div>
          );
        })}
        {extensions.catalog.length === 0 ? (
          <p className="rounded-[var(--fd-radius-lg)] border border-border-subtle p-4 text-[length:var(--fd-text-sm)] text-fg-muted">
            No extensions are installed.
          </p>
        ) : null}
        {extensions.catalog.length > 0 && matchingExtensions.length === 0 ? (
          <p className="rounded-[var(--fd-radius-lg)] border border-border-subtle p-4 text-[length:var(--fd-text-sm)] text-fg-muted">
            No installed extensions match “{query.trim()}”.
          </p>
        ) : null}
      </div>
    </SettingsPage>
  );
}
