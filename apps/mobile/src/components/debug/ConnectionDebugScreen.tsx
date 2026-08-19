/**
 * Connection debug screen.
 *
 * A deliberately transparent, closable full-screen overlay shown while the
 * launch sync is busy. Launch can take a while (relay socket → session key →
 * daemon presence → snapshot), and until it lands the app reads as frozen.
 * Rather than pretending nothing is happening, this spells out the exact
 * connection states, retry schedule, and a live log of what the app is doing.
 *
 * It is diagnostic UX, not a product surface: expect it to be simplified or
 * removed once the underlying launch stalls are ironed out.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { useConnectionLogStore, useRelayStore } from '@/store'
import type { ConnectionLogEntry, ConnectionLogLevel } from '@/store/connection-log-store'
import { useSessionSyncStatus } from '@/hooks/useSessionSyncStatus'
import { ActivityDiamond } from '@/components/ui/ActivityDiamond'
import { Text } from '@/components/ui/Text'

/**
 * Auto-show only after the busy period has lasted long enough that an ordinary
 * launch would have finished — otherwise every cold open flashes the overlay
 * for a split second.
 */
const AUTO_SHOW_DELAY_MS = 2_500

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

function LogLine({ entry }: { entry: ConnectionLogEntry }) {
  const { theme } = useUnistyles()
  const color: Record<ConnectionLogLevel, string> = {
    info: theme.colors.fg.secondary,
    success: theme.colors.success.default,
    warn: theme.colors.warning.default,
    error: theme.colors.danger.default,
  }
  return (
    <View style={styles.logLine}>
      <Text variant="mono" size="2xs" color="faint">
        {formatClock(entry.at)}
      </Text>
      <View style={styles.logBody}>
        <Text variant="mono" size="2xs" style={{ color: color[entry.level] }}>
          {entry.message}
        </Text>
        {entry.detail ? (
          <Text variant="mono" size="2xs" color="muted">
            {entry.detail}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

export const ConnectionDebugScreen = memo(function ConnectionDebugScreen() {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const visible = useConnectionLogStore((s) => s.visible)
  const entries = useConnectionLogStore((s) => s.entries)
  const hide = useConnectionLogStore((s) => s.hide)
  const show = useConnectionLogStore((s) => s.show)
  const status = useSessionSyncStatus()

  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const hasSyncedOnce = useRelayStore((s) => s.hasSyncedOnce)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const error = useRelayStore((s) => s.error)
  const syncDiagnostics = useRelayStore((s) => s.syncDiagnostics)

  // Auto-open while the session is stuck in a busy stage, unless the user has
  // closed the screen once this run.
  useEffect(() => {
    if (!status.isBusy) return
    const timer = setTimeout(() => {
      if (!useConnectionLogStore.getState().dismissedForRun) show()
    }, AUTO_SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [status.isBusy, status.stage, show])

  // One shared clock so elapsed/retry countdowns tick without per-row timers.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [visible])

  const logRef = useRef<ScrollView>(null)
  const lastEntryId = entries.length ? entries[entries.length - 1].id : null
  useEffect(() => {
    if (visible && lastEntryId !== null) {
      logRef.current?.scrollToEnd({ animated: false })
    }
  }, [visible, lastEntryId])

  const elapsedSeconds =
    status.syncStartedAt === null
      ? null
      : Math.max(0, Math.floor((now - status.syncStartedAt) / 1_000))
  const retrySeconds =
    status.nextRetryAt === null
      ? null
      : Math.max(0, Math.ceil((status.nextRetryAt - now) / 1_000))

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={hide}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingTop: insets.top + theme.spacing[4] }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text variant="heading" size="md" weight="semibold">
                {status.isBusy ? status.label : 'Connected'}
              </Text>
              {status.isBusy && status.detail ? (
                <Text variant="caption" size="xs" color="muted">
                  {status.detail}
                </Text>
              ) : (
                <Text variant="caption" size="xs" color="muted">
                  Session is live and synced.
                </Text>
              )}
            </View>
            {status.isBusy ? (
              <ActivityDiamond size={theme.iconSize.lg} color={theme.colors.info.default} />
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

          <ScrollView
            ref={logRef}
            style={styles.stateSection}
            contentContainerStyle={styles.stateContent}
          >
            <Text variant="microlabel" size="2xs" color="faint">
              CONNECTION
            </Text>
            <Row label="Relay" value={connectionStatus.replace('_', ' ')} />
            <Row label="Encrypted channel" value={isEncrypted ? 'yes' : 'no'} />
            <Row
              label="Your Mac"
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
            <Row label="Projects synced" value={hasSyncedOnce ? 'yes' : 'not yet'} />
            {error ? <Row label="Last error" value={error} /> : null}

            <Text variant="microlabel" size="2xs" color="faint" style={styles.sectionGap}>
              SYNC
            </Text>
            {status.isBusy ? (
              <>
                {status.syncStartedAt !== null ? (
                  <Row label="Waiting" value={`${elapsedSeconds}s`} />
                ) : null}
                {status.syncAttempt > 0 ? (
                  <Row label="Attempt" value={String(status.syncAttempt)} />
                ) : null}
                {retrySeconds !== null ? <Row label="Next retry in" value={`${retrySeconds}s`} /> : null}
                {status.lastError ? <Row label="Last error" value={status.lastError} /> : null}
              </>
            ) : (
              <Text variant="caption" size="xs" color="muted">
                Nothing in flight.
              </Text>
            )}
            {syncDiagnostics.lastSuccessAt !== null ? (
              <Row label="Last successful sync" value={formatClock(syncDiagnostics.lastSuccessAt)} />
            ) : null}

            <Text variant="microlabel" size="2xs" color="faint" style={styles.sectionGap}>
              ACTIVITY LOG
            </Text>
            {entries.length === 0 ? (
              <Text variant="caption" size="xs" color="muted">
                No connection activity recorded yet.
              </Text>
            ) : (
              entries.map((entry) => <LogLine key={entry.id} entry={entry} />)
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
})

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
}))
