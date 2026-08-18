import type { ComponentProps } from "react";

import { ActivityView } from "@falcondeck/chat-ui/activity-view";

import { useActivityTailSnapshot } from "../hooks/useActivityTails";

/**
 * Activity, with the streaming tails attached here rather than in App.
 *
 * The tails change once a frame while anything is running. Subscribing at
 * this level keeps that cost inside the view that paints them instead of
 * re-rendering the whole application shell behind it.
 */
export function ActivityPane(
  props: Omit<ComponentProps<typeof ActivityView>, "threadTails">,
) {
  return <ActivityView {...props} threadTails={useActivityTailSnapshot()} />;
}
