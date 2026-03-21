import React, { Fragment, forwardRef, useImperativeHandle } from 'react'

import { View } from 'react-native'

export type FlashListRef<T> = {
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void
  scrollToEnd: (params?: { animated?: boolean }) => void
}

type FlashListProps<T> = {
  data: T[]
  renderItem: (info: { item: T; index: number }) => React.ReactNode
  ListHeaderComponent?: React.ReactNode
  ListFooterComponent?: React.ReactNode
  ListEmptyComponent?: React.ReactNode
}

export const FlashList = forwardRef(function MockFlashList<T>(
  { data, renderItem, ListFooterComponent, ListHeaderComponent, ListEmptyComponent }: FlashListProps<T>,
  ref: React.ForwardedRef<FlashListRef<T>>,
) {
  useImperativeHandle(ref, () => ({
    scrollToOffset: () => {},
    scrollToEnd: () => {},
  }))

  return (
    <View>
      {ListHeaderComponent}
      {data.length === 0
        ? ListEmptyComponent
        : data.map((item, index) => (
            <Fragment key={index}>{renderItem({ item, index })}</Fragment>
          ))}
      {ListFooterComponent}
    </View>
  )
}) as <T>(
  props: FlashListProps<T> & { ref?: React.ForwardedRef<FlashListRef<T>> },
) => React.ReactElement
