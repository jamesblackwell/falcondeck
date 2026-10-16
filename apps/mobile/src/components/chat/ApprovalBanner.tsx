import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AlertTriangle } from "lucide-react-native";
import * as Haptics from "expo-haptics";

import {
  interactiveRequestEvidencePresentation,
  isMcpElicitationRequest,
  safeExternalUrl,
  type ApprovalRequest,
} from "@falcondeck/client-core";

import { Text, Button } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";
import { useExternalUrl } from "./useExternalUrl";
import { layeredFill } from "@/theme/color";

interface ApprovalBannerProps {
  approval: ApprovalRequest;
  pendingCount?: number;
  onAllow?: (requestId: string) => void | Promise<void>;
  onDeny?: (requestId: string) => void | Promise<void>;
  onAlways?: (requestId: string) => void | Promise<void>;
  onOption?: (optionId: string) => void | Promise<void>;
}

/** Provider payloads sometimes put the full tool input JSON in `detail`, even
 * when command/path have already been promoted into their own fields. Keep
 * useful human copy and never expose that transport object in the prompt. */
export function approvalDetail(approval: ApprovalRequest): string | null {
  return interactiveRequestEvidencePresentation(approval).detail;
}

export const ApprovalBanner = memo(function ApprovalBanner({
  approval,
  pendingCount = 1,
  onAllow,
  onDeny,
  onAlways,
  onOption,
}: ApprovalBannerProps) {
  const { theme } = useUnistyles();
  const [isResponding, setIsResponding] = useState(false);
  const respondingRef = useRef<symbol | null>(null);
  const requestIdRef = useRef(approval.request_id);
  requestIdRef.current = approval.request_id;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const detail = useMemo(() => approvalDetail(approval), [approval]);
  const elicitation = isMcpElicitationRequest(approval);
  const signInUrl = safeExternalUrl(approval.path);
  const { open: openSignInUrl, failed: signInOpenFailed } = useExternalUrl(
    signInUrl ?? "",
  );

  useEffect(() => {
    respondingRef.current = null;
    setIsResponding(false);
    setSubmitError(null);
  }, [approval.request_id]);

  /* v8 ignore start — Pressable callbacks with haptics, tested via E2E */
  const handleAllow = useCallback(async () => {
    if (respondingRef.current || !onAllow) return;
    const token = Symbol("approval-allow");
    const requestId = approval.request_id;
    respondingRef.current = token;
    setIsResponding(true);
    setSubmitError(null);
    try {
      await onAllow(approval.request_id);
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      setSubmitError(
        error instanceof Error ? error.message : "Approval action failed",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (respondingRef.current === token) {
        respondingRef.current = null;
        if (requestIdRef.current === requestId) setIsResponding(false);
      }
    }
  }, [approval.request_id, onAllow]);

  const handleDeny = useCallback(async () => {
    if (respondingRef.current || !onDeny) return;
    const token = Symbol("approval-deny");
    const requestId = approval.request_id;
    respondingRef.current = token;
    setIsResponding(true);
    setSubmitError(null);
    try {
      await onDeny(approval.request_id);
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (error) {
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      setSubmitError(
        error instanceof Error ? error.message : "Approval action failed",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (respondingRef.current === token) {
        respondingRef.current = null;
        if (requestIdRef.current === requestId) setIsResponding(false);
      }
    }
  }, [approval.request_id, onDeny]);

  const handleAlways = useCallback(async () => {
    if (respondingRef.current || !onAlways) return;
    const token = Symbol("approval-always");
    const requestId = approval.request_id;
    respondingRef.current = token;
    setIsResponding(true);
    setSubmitError(null);
    try {
      await onAlways(approval.request_id);
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      if (respondingRef.current !== token || requestIdRef.current !== requestId) return;
      setSubmitError(
        error instanceof Error ? error.message : "Approval action failed",
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      if (respondingRef.current === token) {
        respondingRef.current = null;
        if (requestIdRef.current === requestId) setIsResponding(false);
      }
    }
  }, [approval.request_id, onAlways]);

  const handleOption = useCallback(async (optionId: string) => {
    if (respondingRef.current || !onOption) return;
    const token = Symbol("approval-option");
    const requestId = approval.request_id;
    respondingRef.current = token;
    setIsResponding(true);
    setSubmitError(null);
    try {
      await onOption(optionId);
    } catch (error) {
      if (respondingRef.current === token && requestIdRef.current === requestId) {
        setSubmitError(error instanceof Error ? error.message : "Approval action failed");
      }
    } finally {
      if (respondingRef.current === token) {
        respondingRef.current = null;
        if (requestIdRef.current === requestId) setIsResponding(false);
      }
    }
  }, [approval.request_id, onOption]);
  /* v8 ignore stop */

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.icon}>
          <AlertTriangle size={16} color={theme.colors.warning.default} />
        </View>
        <View style={styles.heading}>
          <Text variant="caption" color="warning" weight="semibold">
            {elicitation ? "Sign in required" : "Permission required"}
          </Text>
          <Text selectable variant="label" color="primary">
            {approval.title}
          </Text>
        </View>
        {pendingCount > 1 ? (
          <Text variant="caption" color="muted">
            1 of {pendingCount}
          </Text>
        ) : null}
      </View>
      {approval.command ? (
        <CodeBlock
          code={approval.command}
          language="command"
          previewLines={4}
        />
      ) : null}
      {detail ? (
        <Text selectable variant="caption" color="secondary">
          {detail}
        </Text>
      ) : null}
      {signInUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={signInUrl}
          onPress={() => void openSignInUrl()}
        >
          <Text selectable variant="caption" color="accent">
            {signInUrl}
          </Text>
        </Pressable>
      ) : approval.path && !approval.command?.includes(approval.path) ? (
        <Text selectable variant="caption" color="muted">
          {approval.path}
        </Text>
      ) : null}
      {elicitation && signInUrl ? (
        <Text variant="caption" color="secondary">
          Open the link to finish sign-in, then continue.
        </Text>
      ) : null}
      {signInOpenFailed ? (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          Could not open the sign-in page. Try the link above.
        </Text>
      ) : null}
      <View style={styles.actions}>
        {approval.approval_options ? approval.approval_options.map((option) => (
          <Button
            key={option.option_id}
            variant={option.decision === "allow" ? "default" : "secondary"}
            size="sm"
            label={option.label}
            disabled={isResponding || !onOption}
            onPress={() => void handleOption(option.option_id)}
          />
        )) : <>
          {onDeny ? (
            <Button
              variant="ghost"
              size="sm"
              label={elicitation ? "Cancel" : "Deny"}
              disabled={isResponding}
              onPress={handleDeny}
            />
          ) : null}
          {onAlways ? (
            <Button
              variant="secondary"
              size="sm"
              label="Always allow"
              disabled={isResponding}
              onPress={handleAlways}
            />
          ) : null}
          {onAllow ? (
            <Button
              variant="default"
              size="sm"
              label={elicitation ? "Continue" : "Allow"}
              loading={isResponding}
              onPress={handleAllow}
            />
          ) : null}
        </>}
      </View>
      {(approval.approval_options ? approval.approval_options.length === 0 : !onAllow && !onDeny && !onAlways) ? (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          This provider did not supply an approval decision.
        </Text>
      ) : null}
      {submitError ? (
        <Text accessibilityRole="alert" variant="caption" color="danger">
          {submitError}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    // Opaque: the request floats over the transcript, above the composer.
    ...layeredFill(theme.colors.surface[1], theme.colors.warning.muted),
    borderRadius: theme.radius.xl,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: theme.colors.warning.default,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
    marginVertical: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface[1],
  },
  heading: {
    flex: 1,
    gap: 1,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
