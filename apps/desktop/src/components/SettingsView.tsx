import { useState } from 'react'

import type {
  FalconDeckPreferences,
  RemoteStatusResponse,
  TrustedDevice,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'

import type { AppUpdaterState } from '../hooks/useAppUpdater'
import { GeneralSettingsPanel } from './settings/GeneralSettingsPanel'
import { RemoteAccessPanel } from './settings/RemoteAccessPanel'
import { SettingsSidebar } from './settings/SettingsSidebar'
import type { SettingsSectionId } from './settings/settings-utils'

export type SettingsViewProps = {
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  relayUrl: string
  isStartingRemote: boolean
  remoteControlsDisabled: boolean
  remoteControlsUnavailableReason: string | null
  revokingDeviceId: string | null
  updater: AppUpdaterState
  updaterProgressPercent: number | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onStartPairing: () => void
  onRefreshRemoteStatus: () => void
  onRevokeDevice: (device: TrustedDevice) => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onRestartToInstallUpdate: () => void
  onClose: () => void
}

export function SettingsView(props: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general')

  return (
    <section className="flex h-full min-h-0 bg-surface-1">
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onClose={props.onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-4xl">
          {activeSection === 'general' ? (
            <GeneralSettingsPanel
              workspace={props.workspace}
              preferences={props.preferences}
              updater={props.updater}
              updaterProgressPercent={props.updaterProgressPercent}
              onUpdatePreferences={props.onUpdatePreferences}
              onCheckForUpdates={props.onCheckForUpdates}
              onDownloadUpdate={props.onDownloadUpdate}
              onRestartToInstallUpdate={props.onRestartToInstallUpdate}
            />
          ) : (
            <RemoteAccessPanel
              remoteStatus={props.remoteStatus}
              pairingLink={props.pairingLink}
              relayUrl={props.relayUrl}
              isStartingRemote={props.isStartingRemote}
              remoteControlsDisabled={props.remoteControlsDisabled}
              remoteControlsUnavailableReason={props.remoteControlsUnavailableReason}
              revokingDeviceId={props.revokingDeviceId}
              onStartPairing={props.onStartPairing}
              onRefreshRemoteStatus={props.onRefreshRemoteStatus}
              onRevokeDevice={props.onRevokeDevice}
            />
          )}
        </div>
      </div>
    </section>
  )
}
