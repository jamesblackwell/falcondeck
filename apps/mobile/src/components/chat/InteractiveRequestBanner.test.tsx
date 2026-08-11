import React from "react";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Haptics from "expo-haptics";

import type { InteractiveRequest } from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { InteractiveRequestBanner } from "./InteractiveRequestBanner";

afterEach(cleanup);

function request(
  overrides: Partial<InteractiveRequest> = {},
): InteractiveRequest {
  return {
    request_id: "request-1",
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    method: "item/tool/requestUserInput",
    kind: "question",
    title: "Choose implementation details",
    detail: "The agent needs two decisions before continuing.",
    command: null,
    path: null,
    turn_id: "turn-1",
    item_id: "item-1",
    questions: [
      {
        id: "framework",
        header: "Framework",
        question: "Which framework should be used?",
        is_other: false,
        is_secret: false,
        options: [
          {
            label: "React Native",
            description: "Share the mobile implementation.",
          },
          {
            label: "Native Swift",
            description: "Use platform-specific views.",
          },
        ],
      },
      {
        id: "token",
        header: "Token",
        question: "Enter the deployment token.",
        is_other: true,
        is_secret: true,
        options: null,
      },
    ],
    created_at: "2026-08-09T10:00:00Z",
    ...overrides,
  };
}

function pressableWithText(
  renderer: ReturnType<typeof renderComponent>,
  label: string,
) {
  return renderer.root
    .findAllByType("Pressable" as never)
    .find((pressable) =>
      pressable
        .findAllByType("Text" as never)
        .some((text) => text.props.children === label),
    );
}

describe("InteractiveRequestBanner", () => {
  it("makes provider question context selectable without changing answer controls", () => {
    const renderer = renderComponent(
      <InteractiveRequestBanner request={request()} onRespond={vi.fn()} />,
    );
    const selectableText = renderer.root
      .findAllByType("Text" as any)
      .filter((node) => node.props.selectable === true)
      .flatMap((node) =>
        node.children.filter(
          (child): child is string => typeof child === "string",
        ),
      )
      .join("\n");

    expect(selectableText).toContain("Choose implementation details");
    expect(selectableText).toContain(
      "The agent needs two decisions before continuing.",
    );
    expect(selectableText).toContain("Framework");
    expect(selectableText).toContain("Which framework should be used?");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "React Native" }).props
        .accessibilityRole,
    ).toBe("radio");
    expect(
      renderer.root
        .findByProps({ accessibilityLabel: "React Native" })
        .findAllByType("Text" as any)
        .some((node) => node.props.selectable === true),
    ).toBe(false);
  });

  it("collects ordered option and secret answers before submitting", async () => {
    const onRespond = vi.fn(async () => undefined);
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request()}
        pendingCount={2}
        onRespond={onRespond}
      />,
    );

    expect(textOf(renderer)).toContain("1 of 2");
    const option = renderer.root.findByProps({
      accessibilityLabel: "React Native",
    });
    act(() => option.props.onPress());
    expect(option.props.accessibilityState.checked).toBe(true);

    act(() => pressableWithText(renderer, "Next question")?.props.onPress());
    expect(textOf(renderer)).toContain("Enter the deployment token.");
    expect(textOf(renderer)).toContain("Secret");
    const input = renderer.root.findByProps({
      accessibilityLabel: "Enter the deployment token.",
    });
    expect(input.props.secureTextEntry).toBe(true);
    act(() => input.props.onChangeText("super-secret"));

    await act(async () => {
      pressableWithText(renderer, "Submit answer")?.props.onPress();
      await Promise.resolve();
    });
    expect(onRespond).toHaveBeenCalledWith({
      kind: "question",
      answers: {
        framework: ["React Native"],
        token: ["super-secret"],
      },
    });
  });

  it("keeps answers and exposes an inline retry error when submission fails", async () => {
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({ questions: [request().questions[0]!] })}
        onRespond={async () => {
          throw new Error("Relay disconnected");
        }}
      />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "React Native" })
        .props.onPress(),
    );
    await act(async () => {
      pressableWithText(renderer, "Submit answer")?.props.onPress();
      await Promise.resolve();
    });

    expect(textOf(renderer)).toContain("Relay disconnected");
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "React Native" }).props
        .accessibilityState.checked,
    ).toBe(true);
    expect(notificationAsync).toHaveBeenCalledTimes(1);
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Error,
    );
  });

  it("emits terminal question feedback only after the relay acknowledges the answer", async () => {
    let resolveResponse: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({ questions: [request().questions[0]!] })}
        onRespond={() => response}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "React Native" })
        .props.onPress(),
    );
    act(() => pressableWithText(renderer, "Submit answer")?.props.onPress());

    expect(notificationAsync).not.toHaveBeenCalled();

    await act(async () => {
      resolveResponse?.();
      await response;
    });
    expect(notificationAsync).toHaveBeenCalledOnce();
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });

  it("supports the provider-scoped always-allow approval response", async () => {
    const onRespond = vi.fn(async () => undefined);
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({
          kind: "approval",
          approval_decisions: ["allow", "deny", "always_allow"],
          title: "Allow command?",
          questions: [],
          command: "npm test",
        })}
        onRespond={onRespond}
      />,
    );

    await act(async () => {
      pressableWithText(renderer, "Always allow")?.props.onPress();
      await Promise.resolve();
    });
    expect(onRespond).toHaveBeenCalledWith({
      kind: "approval",
      decision: "always_allow",
    });
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success,
    );
  });

  it("uses warning feedback only after a denial is acknowledged", async () => {
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({
          kind: "approval",
          approval_decisions: ["deny"],
          title: "Allow command?",
          questions: [],
          command: "npm test",
        })}
        onRespond={async () => undefined}
      />,
    );

    await act(async () => {
      pressableWithText(renderer, "Deny")?.props.onPress();
      await Promise.resolve();
    });
    expect(notificationAsync).toHaveBeenCalledOnce();
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Warning,
    );
  });

  it("does not announce approval success before acknowledgement and uses error feedback on failure", async () => {
    let rejectResponse: ((error: Error) => void) | undefined;
    const response = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    const notificationAsync = vi.spyOn(Haptics, "notificationAsync");
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({
          kind: "approval",
          approval_decisions: ["allow"],
          title: "Allow command?",
          questions: [],
          command: "npm test",
        })}
        onRespond={() => response}
      />,
    );

    act(() => pressableWithText(renderer, "Allow")?.props.onPress());
    expect(notificationAsync).not.toHaveBeenCalled();

    await act(async () => {
      rejectResponse?.(new Error("Relay disconnected"));
      await response.catch(() => undefined);
    });
    expect(textOf(renderer)).toContain("Relay disconnected");
    expect(notificationAsync).toHaveBeenCalledOnce();
    expect(notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Error,
    );
  });

  it("does not invent a persistent decision the provider did not offer", () => {
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({
          kind: "approval",
          approval_decisions: ["allow", "deny"],
          title: "Allow command?",
          questions: [],
          command: "npm test",
        })}
        onRespond={vi.fn()}
      />,
    );

    expect(pressableWithText(renderer, "Allow")).toBeDefined();
    expect(pressableWithText(renderer, "Deny")).toBeDefined();
    expect(pressableWithText(renderer, "Always allow")).toBeUndefined();
  });

  it("makes an explicitly unsupported approval visibly non-actionable", () => {
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({
          kind: "approval",
          approval_decisions: [],
          title: "Unknown provider permission",
          questions: [],
        })}
        onRespond={vi.fn()}
      />,
    );

    expect(textOf(renderer)).toContain("did not supply an approval decision");
    expect(pressableWithText(renderer, "Allow")).toBeUndefined();
    expect(pressableWithText(renderer, "Deny")).toBeUndefined();
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
  });

  it("surfaces malformed question requests instead of showing approval actions", () => {
    const renderer = renderComponent(
      <InteractiveRequestBanner
        request={request({ questions: [] })}
        onRespond={vi.fn()}
      />,
    );
    expect(textOf(renderer)).toContain("did not supply a question");
    expect(pressableWithText(renderer, "Allow")).toBeUndefined();
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
  });
});
