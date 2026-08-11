type CompositionKeyboardEvent = {
  key?: string
  keyCode?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

/** True while a browser key event belongs to an active IME composition. */
export function isComposingKeyboardEvent(event: CompositionKeyboardEvent) {
  return Boolean(
    event.nativeEvent?.isComposing ||
      event.nativeEvent?.keyCode === 229 ||
      event.keyCode === 229 ||
      event.key === 'Process',
  )
}
