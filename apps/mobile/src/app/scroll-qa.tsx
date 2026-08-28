import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Redirect } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { StyleSheet } from "react-native-unistyles";

import { Button, Text } from "@/components/ui";
import { useScrollToBottom } from "@/hooks/useScrollToBottom";

/**
 * Dev-only harness for the transcript scroll bug: "scrolling up a page or two
 * snaps you back to the bottom". It mirrors the production wiring in
 * app/(app)/index.tsx — same hook, same maintainVisibleContentPosition config,
 * same header/footer — over a long synthetic thread that streams new blocks so
 * the FlashList autoscroll paths stay live while you drag.
 *
 * The readout counts two failure modes, both measured without a finger on the
 * screen: `yanks` — the gap to the bottom collapsing, i.e. pinned back to the
 * tail — and `drift` — the topmost visible row walking down the list, the
 * escalator that never quite reaches the end.
 */

type QaBlock = { id: string; lines: number };

function buildBlocks(count: number, seedOffset = 0): QaBlock[] {
  return Array.from({ length: count }, (_, index) => {
    const seed = index + seedOffset;
    // Deterministic but wildly varying heights: chat transcripts mix one-line
    // user messages with long assistant answers, and that variance is what
    // makes FlashList's size estimates drift while scrolling up.
    const lines = 1 + ((seed * 7919) % 23);
    return { id: `block-${seed}`, lines };
  });
}

/**
 * A block whose height grows shortly after mount, the way real transcript rows
 * do once markdown, images and tool cards finish measuring. Recycling remounts
 * it, so scrolling up keeps producing layout corrections.
 */
function QaBlockView({ block, settle }: { block: QaBlock; settle: boolean }) {
  const [settled, setSettled] = useState(!settle);

  useEffect(() => {
    if (!settle) return;
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), 250);
    return () => clearTimeout(timer);
  }, [block.id, settle]);

  const lines = settled ? block.lines : Math.max(1, Math.round(block.lines / 3));

  return (
    <View style={styles.block}>
      <Text variant="caption" color="muted">
        {block.id}
      </Text>
      <Text variant="body">
        {Array.from({ length: lines }, (_, line) => `line ${line} of ${block.id}`).join("\n")}
      </Text>
    </View>
  );
}

export default function ScrollQaScreen() {
  const [blocks, setBlocks] = useState(() => buildBlocks(200));
  const [streaming, setStreaming] = useState(true);
  const [settle, setSettle] = useState(true);
  const [offset, setOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [yanks, setYanks] = useState(0);
  const [lastJump, setLastJump] = useState(0);
  const [drift, setDrift] = useState(0);
  const [lastDrift, setLastDrift] = useState(0);
  const topIndexRef = useRef<number | null>(null);
  const lastGapRef = useRef(0);
  const draggingRef = useRef(false);

  const {
    listRef,
    showJumpButton,
    autoscrollToBottomThreshold,
    onContentSizeChange,
    onScroll: onScrollFollow,
    onScrollBeginDrag: onScrollBeginDragFollow,
    onScrollEndDrag: onScrollEndDragFollow,
    onMomentumScrollEnd,
    onTouchStart,
    onTouchEnd,
    scrollToBottom,
  } = useScrollToBottom<QaBlock>();

  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => {
      setBlocks((current) => [
        ...current,
        ...buildBlocks(1, current.length + 1000),
      ]);
    }, 900);
    return () => clearInterval(timer);
  }, [streaming]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      // Raw offset deltas can't tell a yank from a maintainVisibleContentPosition
      // correction (which raises the offset but keeps the view still), so measure
      // the gap to the bottom instead: collapsing it without a finger is the bug.
      const gap = event.nativeEvent.contentSize.height - y;
      if (!draggingRef.current && lastGapRef.current > 3000 && gap < 1500) {
        setYanks((count) => count + 1);
        setLastJump(Math.round(lastGapRef.current - gap));
      }
      lastGapRef.current = gap;
      setOffset(Math.round(y));
      setContentHeight(Math.round(event.nativeEvent.contentSize.height));
      onScrollFollow(event);
    },
    [onScrollFollow],
  );

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      onScrollBeginDragFollow(event);
    },
    [onScrollBeginDragFollow],
  );

  const onScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false;
      onScrollEndDragFollow(event);
    },
    [onScrollEndDragFollow],
  );

  const renderItem = useCallback(
    ({ item }: { item: QaBlock }) => <QaBlockView block={item} settle={settle} />,
    [settle],
  );

  // Visual drift: the topmost visible row walking *down* the list without a
  // finger on the screen is the escalator, whether or not it reaches the end.
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
      const top = viewableItems[0]?.index;
      if (top === null || top === undefined) return;
      const previous = topIndexRef.current;
      topIndexRef.current = top;
      if (previous !== null && !draggingRef.current && top - previous >= 2) {
        setDrift((count) => count + 1);
        setLastDrift(top - previous);
      }
    },
    [],
  );

  const distanceFromBottom = useMemo(
    () => Math.round(contentHeight - offset),
    [contentHeight, offset],
  );

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <View style={styles.screen}>
      <View style={styles.readout}>
        <Text variant="caption" accessibilityLabel={`qa-yanks-${yanks}`}>
          {`yanks ${yanks} (-${lastJump}) · drift ${drift} (+${lastDrift}) · gap ${distanceFromBottom} · threshold ${autoscrollToBottomThreshold} · blocks ${blocks.length}`}
        </Text>
        <View style={styles.controls}>
          <Button
            variant="ghost"
            size="sm"
            label={streaming ? "Pause stream" : "Resume stream"}
            onPress={() => setStreaming((current) => !current)}
          />
          <Button
            variant="ghost"
            size="sm"
            label={settle ? "Static heights" : "Settling heights"}
            onPress={() => setSettle((current) => !current)}
          />
          <Button
            variant="ghost"
            size="sm"
            label="Reset"
            onPress={() => {
              setYanks(0);
              setLastJump(0);
              setDrift(0);
              setLastDrift(0);
            }}
          />
        </View>
      </View>
      <View style={styles.listContainer}>
        <FlashList
          ref={listRef}
          data={blocks}
          renderItem={renderItem}
          keyExtractor={(block: QaBlock) => block.id}
          accessibilityLabel="Scroll QA transcript"
          showsVerticalScrollIndicator={false}
          maintainVisibleContentPosition={{
            autoscrollToBottomThreshold,
            startRenderingFromBottom: true,
          }}
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          onScrollEndDrag={onScrollEndDrag}
          onContentSizeChange={onContentSizeChange}
          onMomentumScrollEnd={onMomentumScrollEnd}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          onResponderRelease={onTouchEnd}
          onViewableItemsChanged={onViewableItemsChanged}
          scrollEventThrottle={16}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View style={styles.loadOlderContainer}>
              <Button variant="ghost" size="sm" label="Load older messages" onPress={() => {}} />
            </View>
          }
          ListFooterComponent={<View style={styles.listBottomSpacer} />}
        />
      </View>
      {showJumpButton ? (
        <Button
          variant="ghost"
          size="sm"
          label="Jump to bottom"
          onPress={() => scrollToBottom()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  screen: {
    flex: 1,
    paddingTop: rt.insets.top,
    paddingBottom: rt.insets.bottom,
    backgroundColor: theme.colors.surface[0],
  },
  readout: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  controls: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  listContainer: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing[4],
  },
  listBottomSpacer: {
    height: theme.spacing[6],
  },
  loadOlderContainer: {
    alignItems: "center",
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  block: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
}));
