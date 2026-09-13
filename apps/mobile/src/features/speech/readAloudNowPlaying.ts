import { Platform } from 'react-native'
import { PlaybackNotificationManager as notification } from 'react-native-audio-api'

/** Serialise native updates so a late show cannot resurrect a stopped session. */
export class ReadAloudNowPlaying {
  private pending = Promise.resolve()
  private removeListeners: (() => void)[] = []

  start(onPause: (paused: boolean) => void, onStop: () => void): void {
    if (Platform.OS !== 'ios') return
    this.removeListeners.forEach((remove) => remove())
    this.removeListeners = [
      notification.addEventListener('playbackNotificationPause', () => onPause(true)),
      notification.addEventListener('playbackNotificationPlay', () => onPause(false)),
      notification.addEventListener('playbackNotificationStop', onStop),
    ].map((subscription) => () => subscription.remove())
    this.enqueue(async () => {
      await notification.show({ title: 'Read Aloud', artist: 'FalconDeck', state: 'playing', speed: 1 })
      for (const control of ['nextTrack', 'previousTrack', 'skipForward', 'skipBackward', 'seekTo'] as const) {
        await notification.enableControl(control, false)
      }
      await notification.enableControl('play', true)
      await notification.enableControl('pause', true)
      await notification.enableControl('stop', true)
    })
  }

  setPaused(paused: boolean): void {
    if (Platform.OS !== 'ios') return
    this.enqueue(() => notification.show({ state: paused ? 'paused' : 'playing', speed: paused ? 0 : 1 }))
  }

  stop(): void {
    if (Platform.OS !== 'ios') return
    this.removeListeners.forEach((remove) => remove())
    this.removeListeners = []
    this.enqueue(async () => {
      for (const control of ['play', 'pause', 'stop'] as const) {
        await notification.enableControl(control, false)
      }
      await notification.hide()
    })
  }

  private enqueue(action: () => Promise<void>): void {
    this.pending = this.pending.then(action).catch((error: unknown) => {
      console.warn('Unable to update Read Aloud system controls', error)
    })
  }
}
