import { memo, useCallback, useMemo, useState } from 'react'
import { ScrollView, Switch, TextInput, View, useWindowDimensions } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import type { AgentControlSettings, Automation } from '@falcondeck/client-core'

import { Button, NativeSheet, Text } from '@/components/ui'
import {
  automationDraftArguments,
  automationDraftError,
  automationDraftFromDefinition,
  automationDraftIsElevated,
  emptyAutomationDraft,
  type AutomationDraft,
} from '@/features/automations/model'

type EditorTarget =
  | { kind: 'create'; workspacePath: string }
  | { kind: 'edit'; automation: Automation }

export type AutomationEditorSubmit = {
  operation: 'automation.create' | 'automation.update'
  arguments: Record<string, unknown>
  expectedRevision?: number
}

export const AutomationEditorSheet = memo(function AutomationEditorSheet({
  target,
  settings,
  onClose,
  onSubmit,
}: {
  target: EditorTarget
  settings: AgentControlSettings | null
  onClose: () => void
  onSubmit: (submission: AutomationEditorSubmit) => Promise<void>
}) {
  const { height } = useWindowDimensions()
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    target.kind === 'edit'
      ? automationDraftFromDefinition(target.automation)
      : emptyAutomationDraft(settings, target.workspacePath),
  )
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [validation, setValidation] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const error = useMemo(() => automationDraftError(draft), [draft])
  const elevated = useMemo(() => automationDraftIsElevated(draft), [draft])
  const elevatedBlocked = elevated && !settings?.allow_elevated_automations

  const set = useCallback(<K extends keyof AutomationDraft>(
    key: K,
    value: AutomationDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }, [])

  const setSchedule = useCallback(<K extends keyof AutomationDraft>(
    key: K,
    value: AutomationDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setScheduleDirty(true)
  }, [])

  const submit = useCallback(async () => {
    const currentError = automationDraftError(draft)
    if (currentError) {
      setValidation(currentError)
      return
    }
    setValidation(null)
    setIsBusy(true)
    try {
      const arguments_ = automationDraftArguments(draft)
      if (target.kind === 'edit') {
        if (!scheduleDirty) delete arguments_.trigger
        await onSubmit({
          operation: 'automation.update',
          arguments: { automation_id: target.automation.id, ...arguments_ },
          expectedRevision: target.automation.revision,
        })
      } else {
        await onSubmit({ operation: 'automation.create', arguments: arguments_ })
      }
    } catch (submitError) {
      setValidation(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setIsBusy(false)
    }
  }, [draft, onSubmit, scheduleDirty, target])

  return (
    <NativeSheet onClose={onClose} accessibilityLabel="Close automation editor">
      <View style={styles.header}>
        <Text variant="heading" size="lg">
          {target.kind === 'create' ? 'New automation' : 'Edit automation'}
        </Text>
        <Text variant="caption" color="muted">
          Runs on the paired daemon through its normal agent threads and permissions.
        </Text>
      </View>
      <ScrollView
        style={[styles.scroll, { maxHeight: height * 0.72 }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Field label="Name" value={draft.name} onChangeText={(value) => set('name', value)} />
        <Field
          label="Description"
          value={draft.description}
          onChangeText={(value) => set('description', value)}
          placeholder="Optional"
        />

        <FormSection title="Schedule">
          <ChipSelect
            label="Type"
            value={draft.scheduleKind}
            options={[
              ['cron', 'Cron'],
              ['interval', 'Interval'],
              ['once', 'One time'],
            ]}
            onChange={(value) => setSchedule('scheduleKind', value as AutomationDraft['scheduleKind'])}
          />
          {draft.scheduleKind === 'cron' ? (
            <>
              <Field
                label="Cron expression (five fields)"
                value={draft.expression}
                onChangeText={(value) => setSchedule('expression', value)}
                placeholder="0 8 * * 1-5"
                mono
              />
              <Field
                label="Timezone"
                value={draft.timezone}
                onChangeText={(value) => setSchedule('timezone', value)}
                placeholder="Europe/London"
                mono
              />
            </>
          ) : draft.scheduleKind === 'interval' ? (
            <Field
              label="Every (seconds, minimum 60)"
              value={draft.everySeconds}
              onChangeText={(value) => setSchedule('everySeconds', value)}
              keyboardType="number-pad"
              mono
            />
          ) : (
            <Field
              label="Run at (RFC 3339 with offset)"
              value={draft.runAt}
              onChangeText={(value) => setSchedule('runAt', value)}
              placeholder="2026-08-24T10:00:00+01:00"
              autoCapitalize="none"
              mono
            />
          )}
        </FormSection>

        <FormSection title="Task">
          <Field
            label="Instruction"
            value={draft.instruction}
            onChangeText={(value) => set('instruction', value)}
            placeholder="Review the project and report anything that needs attention."
            multiline
          />
          <SwitchField
            label="Conditional result"
            description="Treat an exact marker response as a successful no-action run."
            value={draft.conditional}
            onValueChange={(value) => set('conditional', value)}
          />
          {draft.conditional ? (
            <Field
              label="No-action marker"
              value={draft.noActionMarker}
              onChangeText={(value) => set('noActionMarker', value)}
              mono
            />
          ) : null}
        </FormSection>

        <FormSection title="Execution target">
          <Field
            label="Workspace path"
            value={draft.workspacePath}
            onChangeText={(value) => set('workspacePath', value)}
            placeholder="/Users/me/Code/project"
            autoCapitalize="none"
            mono
          />
          <ChipSelect
            label="Provider"
            value={draft.provider}
            options={[
              ['codex', 'Codex'],
              ['claude', 'Claude'],
            ]}
            onChange={(value) => set('provider', value)}
          />
          <ChipSelect
            label="Thread strategy"
            value={draft.threadKind}
            options={[
              ['managed', 'Managed'],
              ['existing', 'Existing'],
              ['new_each_run', 'New each run'],
            ]}
            onChange={(value) => set('threadKind', value as AutomationDraft['threadKind'])}
          />
          {draft.threadKind !== 'new_each_run' ? (
            <Field
              label="Thread id"
              value={draft.threadId}
              onChangeText={(value) => set('threadId', value)}
              placeholder={draft.threadKind === 'managed' ? 'Assigned on first run' : 'Required'}
              autoCapitalize="none"
              mono
            />
          ) : null}
          <Field
            label="Model id"
            value={draft.modelId}
            onChangeText={(value) => set('modelId', value)}
            placeholder="Provider default"
            autoCapitalize="none"
            mono
          />
          <Field
            label="Permission mode"
            value={draft.permissionMode}
            onChangeText={(value) => set('permissionMode', value)}
            placeholder="Provider default"
            autoCapitalize="none"
            mono
          />
          <Field
            label="Sandbox mode"
            value={draft.sandboxMode}
            onChangeText={(value) => set('sandboxMode', value)}
            placeholder="Provider default"
            autoCapitalize="none"
            mono
          />
          <Field
            label="Selected skills"
            value={draft.selectedSkills}
            onChangeText={(value) => set('selectedSkills', value)}
            placeholder="skill-one, skill-two"
            autoCapitalize="none"
            mono
          />
          <Field
            label="Required connectors"
            value={draft.requiredConnectors}
            onChangeText={(value) => set('requiredConnectors', value)}
            placeholder="gmail, linear"
            autoCapitalize="none"
            mono
          />
        </FormSection>

        <FormSection title="Run policy">
          <ChipSelect
            label="Overlapping runs"
            value={draft.concurrencyPolicy}
            options={[
              ['skip', 'Skip'],
              ['queue_one', 'Queue one'],
              ['allow', 'Allow'],
            ]}
            onChange={(value) => set('concurrencyPolicy', value as AutomationDraft['concurrencyPolicy'])}
          />
          <ChipSelect
            label="Missed runs"
            value={draft.misfirePolicy}
            options={[
              ['skip', 'Skip'],
              ['run_once', 'Run once'],
            ]}
            onChange={(value) => set('misfirePolicy', value as AutomationDraft['misfirePolicy'])}
          />
        </FormSection>

        {elevated ? (
          <View style={styles.warning}>
            <Text variant="label" color="danger">Elevated authority</Text>
            <Text variant="caption" color="secondary">
              This automation uses bypassPermissions or danger-full-access.
              {elevatedBlocked ? ' Elevated automations are disabled on the daemon.' : ''}
            </Text>
          </View>
        ) : null}
        {validation ? (
          <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
            {validation}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.actions}>
        <Button variant="ghost" label="Cancel" onPress={onClose} />
        <Button
          label={target.kind === 'create' ? 'Create automation' : 'Save changes'}
          loading={isBusy}
          disabled={Boolean(error) || elevatedBlocked}
          onPress={() => void submit()}
        />
      </View>
    </NativeSheet>
  )
})

const Field = memo(function Field({
  label,
  mono,
  multiline,
  ...props
}: React.ComponentProps<typeof TextInput> & { label: string; mono?: boolean }) {
  const { theme } = useUnistyles()
  return (
    <View style={styles.field}>
      <Text variant="caption" color="muted">{label}</Text>
      <TextInput
        {...props}
        multiline={multiline}
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.fg.muted}
        selectionColor={theme.colors.accent.default}
        style={[styles.input, mono ? styles.inputMono : null, multiline ? styles.textarea : null]}
      />
    </View>
  )
})

const FormSection = memo(function FormSection({
  title,
  children,
}: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="microlabel">{title}</Text>
      {children}
    </View>
  )
})

const ChipSelect = memo(function ChipSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  return (
    <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text variant="caption" color="muted">{label}</Text>
      <View style={styles.chips}>
        {options.map(([optionValue, optionLabel]) => (
          <Button
            key={optionValue}
            size="sm"
            variant={value === optionValue ? 'secondary' : 'ghost'}
            label={optionLabel}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === optionValue }}
            onPress={() => onChange(optionValue)}
          />
        ))}
      </View>
    </View>
  )
})

const SwitchField = memo(function SwitchField({
  label,
  description,
  value,
  onValueChange,
}: {
  label: string
  description: string
  value: boolean
  onValueChange: (value: boolean) => void
}) {
  const { theme } = useUnistyles()
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchCopy}>
        <Text variant="label">{label}</Text>
        <Text variant="caption" color="muted">{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        trackColor={{ false: theme.colors.surface[3], true: theme.colors.accent.default }}
        ios_backgroundColor={theme.colors.surface[3]}
        thumbColor={theme.colors.white}
      />
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  header: { paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[3], gap: theme.spacing[1] },
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[5], gap: theme.spacing[4] },
  section: { gap: theme.spacing[3] },
  field: { gap: theme.spacing[1.5] },
  input: {
    minHeight: theme.minTouchTarget,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface[2],
    color: theme.colors.fg.primary,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontFamily: theme.fontFamily.sans,
    fontSize: theme.fontSize.md,
  },
  inputMono: { fontFamily: theme.fontFamily.mono, fontSize: theme.fontSize.sm },
  textarea: { minHeight: 112, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[1] },
  switchRow: { minHeight: theme.minTouchTarget, flexDirection: 'row', alignItems: 'center', gap: theme.spacing[4] },
  switchCopy: { flex: 1, gap: theme.spacing[1] },
  warning: { padding: theme.spacing[3], borderRadius: theme.radius.lg, backgroundColor: theme.colors.danger.muted, gap: theme.spacing[1] },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[5],
    paddingTop: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
}))
