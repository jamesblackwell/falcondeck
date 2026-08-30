/**
 * Connection debug screen.
 *
 * Opened explicitly from the connection icon. The first layer states the
 * current connection state; detailed transport history stays opt-in.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { SessionSyncStatus } from '@/lib/session-status'
import { useConnectionLogStore, useRelayStore } from '@/store'
import {
  connectionActionDurationMs,
  formatConnectionDurationMs,
  isConnectionActionInFlight,
  type ConnectionLogEntry,
  type ConnectionLogLevel,
} from '@/store/connection-log-store'
import { useSessionSyncStatus } from '@/hooks/useSessionSyncStatus'
import { ActivityDiamond } from '@/components/ui/ActivityDiamond'
import { Text } from '@/components/ui/Text'

function formatClock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="caption" size="xs" color="muted">
        {label}
      </Text>
      <Text variant="caption" size="xs" color="primary" style={styles.rowValue}>
        {value}
      </Text>
    </View>
  )
}

const LogLine = memo(
  function LogLine({
    entry,
    now,
  }: {
    entry: ConnectionLogEntry
    now: number
  }) {
    const { theme } = useUnistyles()
    const color: Record<ConnectionLogLevel, string> = {
      info: theme.colors.fg.secondary,
      success: theme.colors.success.default,
      warn: theme.colors.warning.default,
      error: theme.colors.danger.default,
    }
    const inFlight = isConnectionActionInFlight(entry)
    const durationMs = connectionActionDurationMs(entry, now)
    return (
      <View style={styles.logLine}>
        <Text variant="mono" size="2xs" color="faint">
          {formatClock(entry.at)}
        </Text>
        <View style={styles.logBody}>
          <View style={styles.logHeadline}>
            <Text
              variant="mono"
              size="2xs"
              style={[styles.logMessage, { color: color[entry.level] }]}
            >
              {entry.message}
              {entry.count && entry.count > 1 ? ` ×${entry.count}` : ''}
            </Text>
            {durationMs != null ? (
              <Text
                variant="mono"
                size="2xs"
                color={inFlight ? 'info' : 'faint'}
                style={styles.logDuration}
              >
                {formatConnectionDurationMs(durationMs)}
              </Text>
            ) : null}
          </View>
          {entry.detail ? (
            <Text variant="mono" size="2xs" color="muted">
              {entry.detail}
            </Text>
          ) : null}
        </View>
      </View>
    )
  },
  // Only rows whose visible duration label actually changed re-render on a
  // clock tick — settled rows have a fixed duration and skip every tick.
  (prev, next) => {
    if (prev.entry !== next.entry) return false
    const prevDuration = connectionActionDurationMs(prev.entry, prev.now)
    const nextDuration = connectionActionDurationMs(next.entry, next.now)
    if (prevDuration === null || nextDuration === null) {
      return prevDuration === nextDuration
    }
    return (
      formatConnectionDurationMs(prevDuration) ===
      formatConnectionDurationMs(nextDuration)
    )
  },
)

export const ConnectionDebugScreen = memo(function ConnectionDebugScreen() {
  const visible = useConnectionLogStore((s) => s.visible)
  const status = useSessionSyncStatus()

  if (!visible) return null
  return <ConnectionDebugBody status={status} />
})

function ConnectionDebugBody({ status }: { status: SessionSyncStatus }) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const entries = useConnectionLogStore((s) => s.entries)
  const hide = useConnectionLogStore((s) => s.hide)
  const hasInFlight = entries.some(isConnectionActionInFlight)

  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const hasSyncedOnce = useRelayStore((s) => s.hasSyncedOnce)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const error = useRelayStore((s) => s.error)
  const syncDiagnostics = useRelayStore((s) => s.syncDiagnostics)

  const [showDetails, setShowDetails] = useState(false)

  // One shared clock so elapsed/retry countdowns tick without per-row timers.
  // Sub-second resolution is only worth paying for while the log is open with
  // an action actually in flight; the summary layer reads fine at 1s.
  const [now, setNow] = useState(() => Date.now())
  const fastClock = showDetails && hasInFlight
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), fastClock ? 250 : 1_000)
    return () => clearInterval(timer)
  }, [fastClock])

  const logRef = useRef<ScrollView>(null)
  const lastEntryId = entries.length ? entries[entries.length - 1].id : null
  useEffect(() => {
    if (lastEntryId !== null) {
      logRef.current?.scrollToEnd({ animated: false })
    }
  }, [lastEntryId])

  const elapsedLabel =
    status.syncStartedAt === null
      ? null
      : formatConnectionDurationMs(now - status.syncStartedAt)
  const retrySeconds =
    status.nextRetryAt === null
      ? null
      : Math.max(0, Math.ceil((status.nextRetryAt - now) / 1_000))

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={hide}
    >
      <View style={styles.backdrop}>
        <View
          style={[styles.sheet, { paddingTop: insets.top + theme.spacing[4] }]}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text variant="heading" size="md" weight="semibold">
                {status.label}
              </Text>
            </View>
            {status.isBusy ? (
              <ActivityDiamond
                size={theme.iconSize.lg}
                color={theme.colors.info.default}
              />
            ) : (
              <View style={styles.readyDot} />
            )}
            <Pressable
              onPress={hide}
              accessibilityRole="button"
              accessibilityLabel="Close connection status"
              hitSlop={12}
              style={styles.closeButton}
            >
              <Text variant="label" size="sm" color="accent">
                Close
              </Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => setShowDetails((current) => !current)}
            accessibilityRole="button"
            accessibilityLabel={
              showDetails
                ? 'Hide connection details'
                : 'View connection details'
            }
            style={styles.detailsButton}
          >
            <Text variant="label" size="sm" color="accent">
              {showDetails
                ? 'Hide connection details'
                : 'View connection details'}
            </Text>
          </Pressable>

          {showDetails ? (
            <ScrollView
              ref={logRef}
              style={styles.stateSection}
              contentContainerStyle={styles.stateContent}
            >
              <Text variant="microlabel" size="2xs" color="faint">
                CONNECTION
              </Text>
              <Row label="Relay" value={connectionStatus.replace('_', ' ')} />
              <Row
                label="Encrypted channel"
                value={isEncrypted ? 'yes' : 'no'}
              />
              <Row
                label="Desktop"
                value={
                  machinePresence === null
                    ? 'unknown'
                    : machinePresence.daemon_connected
                      ? machinePresence.daemon_rpc_ready === false
                        ? 'online (sync repairing)'
                        : 'online'
                      : 'offline'
                }
              />
              <Row
                label="Projects synced"
                value={hasSyncedOnce ? 'yes' : 'not yet'}
              />
              {error ? <Row label="Last error" value={error} /> : null}

              <Text
                variant="microlabel"
                size="2xs"
                color="faint"
                style={styles.sectionGap}
              >
                SYNC
              </Text>
              {status.isBusy ? (
                <>
                  {elapsedLabel !== null ? (
                    <Row label="Waiting" value={elapsedLabel} />
                  ) : null}
                  {status.syncAttempt > 0 ? (
                    <Row label="Attempt" value={String(status.syncAttempt)} />
                  ) : null}
                  {retrySeconds !== null ? (
                    <Row label="Next retry in" value={`${retrySeconds}s`} />
                  ) : null}
                  {status.lastError ? (
                    <Row label="Last error" value={status.lastError} />
                  ) : null}
                </>
              ) : (
                <Text variant="caption" size="xs" color="muted">
                  Nothing in flight.
                </Text>
              )}
              {syncDiagnostics.lastSuccessAt !== null ? (
                <Row
                  label="Last successful sync"
                  value={formatClock(syncDiagnostics.lastSuccessAt)}
                />
              ) : null}

              <Text
                variant="microlabel"
                size="2xs"
                color="faint"
                style={styles.sectionGap}
              >
                ACTIVITY LOG
              </Text>
              {entries.length === 0 ? (
                <Text variant="caption" size="xs" color="muted">
                  No connection activity recorded yet.
                </Text>
              ) : (
                entries.map((entry) => (
                  <LogLine key={entry.id} entry={entry} now={now} />
                ))
              )}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  sheet: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  headerText: {
    flex: 1,
    gap: theme.spacing[1] / 2,
  },
  readyDot: {
    width: theme.iconSize.lg,
    height: theme.iconSize.lg,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.success.default,
  },
  closeButton: {
    minWidth: theme.minTouchTarget,
    minHeight: theme.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateSection: {
    flex: 1,
  },
  detailsButton: {
    alignSelf: 'center',
    minHeight: theme.minTouchTarget,
    justifyContent: 'center',
    marginTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  stateContent: {
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[6],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[2],
  },
  rowValue: {
    flex: 1,
    textAlign: 'right',
  },
  sectionGap: {
    marginTop: theme.spacing[3],
  },
  logLine: {
    flexDirection: 'row',
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1] / 2,
  },
  logBody: {
    flex: 1,
    gap: 1,
  },
  logHeadline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[2],
  },
  logMessage: {
    flex: 1,
  },
  logDuration: {
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
}))
