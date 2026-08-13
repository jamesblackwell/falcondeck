import { useState } from "react";

import type { ExtensionSnapshot } from "@falcondeck/client-core";
import { ActivityDiamond, Badge, Button } from "@falcondeck/ui";

function permissionPresentation(permission: string) {
  if (permission === "threads:read") {
    return {
      title: "Read thread summaries",
      description:
        "Allows titles, status, timestamps, and pending-request counts. Messages and transcripts stay private.",
    };
  }
  return { title: permission, description: "Requested extension capability." };
}

export function ExtensionsPanel({
  extensions,
  onSetEnabled,
  onSetPermission,
}: {
  extensions: ExtensionSnapshot;
  onSetEnabled: (extensionId: string, enabled: boolean) => Promise<void>;
  onSetPermission: (
    extensionId: string,
    permission: string,
    granted: boolean,
  ) => Promise<void>;
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Extensions
        </h1>
        <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-muted">
          Extensions run behind the local daemon and stay synchronized across
          your clients.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}
      <div className="space-y-3">
        {extensions.catalog.map((extension) => {
          const unsupportedContributions =
            extension.contributes.unsupported ?? [];
          return (
            <section
              key={extension.id}
              className="rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-medium text-fg-primary">
                      {extension.name}
                    </h2>
                    {extension.bundled ? <Badge>Official</Badge> : null}
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
                        const presentation = permissionPresentation(permission);
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
                  onClick={() => void update(extension.id, !extension.enabled)}
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
          );
        })}
        {extensions.catalog.length === 0 ? (
          <p className="rounded-[var(--fd-radius-lg)] border border-border-subtle p-4 text-[length:var(--fd-text-sm)] text-fg-muted">
            No extensions are installed.
          </p>
        ) : null}
      </div>
    </div>
  );
}
