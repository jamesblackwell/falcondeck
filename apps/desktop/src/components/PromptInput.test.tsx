import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptInput } from "@falcondeck/chat-ui";

const noop = vi.fn();
const imageCapableAgent = {
  supports_review: false,
  supports_goals: false,
  supports_images: true,
  supports_skills: true,
  supports_interrupt: true,
  supports_steering: false,
  supports_forking: false,
  sandbox_modes: [],
  permission_modes: [],
};

const promptInputProps = {
  value: "",
  onValueChange: noop,
  onSubmit: noop,
  onPickImages: noop,
  onRemoveAttachment: noop,
  attachments: [],
  capabilities: imageCapableAgent,
  skills: [],
  selectedProvider: "codex" as const,
  onProviderChange: noop,
  providerLocked: false,
  showProviderSelector: false,
  models: [],
  selectedModelId: null,
  onModelChange: noop,
  reasoningOptions: ["low", "medium", "high"],
  selectedEffort: "medium",
  onEffortChange: noop,
  disabled: false,
  sendDisabled: false,
};

describe("PromptInput", () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "scrollHeight",
  );

  afterEach(() => {
    if (originalScrollHeight) {
      Object.defineProperty(
        HTMLTextAreaElement.prototype,
        "scrollHeight",
        originalScrollHeight,
      );
      return;
    }
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number })
      .scrollHeight;
  });

  it("gives the composer a stable accessible name and exposes its disabled state", () => {
    const { rerender } = render(<PromptInput {...promptInputProps} />);
    expect(
      screen.getByRole("textbox", { name: "Message composer" }),
    ).toBeEnabled();

    rerender(<PromptInput {...promptInputProps} disabled />);
    expect(
      screen.getByRole("textbox", { name: "Message composer" }),
    ).toBeDisabled();
  });

  it("announces image preparation and blocks every send path until it settles", () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="Describe this image"
        onSubmit={onSubmit}
        preparingAttachmentCount={2}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing 2 images…");
    const preparingButton = screen.getByRole("button", {
      name: "Preparing images",
    });
    expect(preparingButton).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Message composer" }),
      {
        key: "Enter",
      },
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps an active turn interruptible while a follow-up image prepares", () => {
    render(
      <PromptInput
        {...promptInputProps}
        isRunning
        onStop={vi.fn()}
        preparingAttachmentCount={1}
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: [],
          permission_modes: [],
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Preparing 1 image…");
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Preparing images" }),
    ).not.toBeInTheDocument();
  });

  it("accepts image drops with visible feedback and ignores non-file drags", () => {
    const onPickImages = vi.fn();
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    const files = {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
    } as unknown as FileList;
    const dataTransfer = {
      types: ["Files"],
      files,
      dropEffect: "none",
    };
    render(<PromptInput {...promptInputProps} onPickImages={onPickImages} />);

    const textbox = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.dragEnter(textbox, { dataTransfer });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Drop images to attach",
    );
    fireEvent.dragOver(textbox, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(textbox, { dataTransfer });
    expect(onPickImages).toHaveBeenCalledWith([file]);
    expect(screen.queryByText("Drop images to attach")).not.toBeInTheDocument();

    fireEvent.dragEnter(textbox, {
      dataTransfer: { types: ["text/plain"], files },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("attaches supported images from a mixed drop and names skipped files", () => {
    const onPickImages = vi.fn();
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const document = new File(["notes"], "brief.pdf", {
      type: "application/pdf",
    });
    const files = [image, document] as unknown as FileList;
    const dataTransfer = {
      types: ["Files"],
      items: [
        { kind: "file", type: "image/png" },
        { kind: "file", type: "application/pdf" },
      ],
      files,
      dropEffect: "none",
    };
    render(<PromptInput {...promptInputProps} onPickImages={onPickImages} />);

    const textbox = screen.getByRole("textbox", { name: "Message composer" });
    fireEvent.dragEnter(textbox, { dataTransfer });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Drop images to attach",
    );
    fireEvent.drop(textbox, { dataTransfer });

    expect(onPickImages).toHaveBeenCalledWith([image]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only images can be attached right now. brief.pdf was not attached.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss attachment message" }),
    );
    expect(screen.queryByText(/brief\.pdf was not attached/)).toBeNull();
  });

  it("explains unsupported clipboard files instead of silently discarding them", () => {
    const onPickImages = vi.fn();
    const document = new File(["notes"], "brief.pdf", {
      type: "application/pdf",
    });
    render(<PromptInput {...promptInputProps} onPickImages={onPickImages} />);

    fireEvent.paste(screen.getByRole("textbox", { name: "Message composer" }), {
      clipboardData: {
        items: [{ kind: "file", type: "application/pdf" }],
        files: [document],
      },
    });

    expect(onPickImages).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only images can be attached right now. brief.pdf was not attached.",
    );
  });

  it("clears an attachment warning when the selected agent changes", () => {
    const { rerender } = render(
      <PromptInput
        {...promptInputProps}
        capabilities={{ ...imageCapableAgent, supports_images: false }}
      />,
    );
    const image = new File(["image"], "clipboard.png", { type: "image/png" });

    fireEvent.paste(screen.getByRole("textbox", { name: "Message composer" }), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png" }],
        files: [image],
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The selected agent does not support image attachments.",
    );

    rerender(
      <PromptInput
        {...promptInputProps}
        selectedProvider="claude"
        capabilities={imageCapableAgent}
      />,
    );
    expect(screen.queryByText("The selected agent does not support image attachments.")).toBeNull();
  });

  it("attaches an image pasted directly into the composer", () => {
    const onPickImages = vi.fn();
    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    render(<PromptInput {...promptInputProps} onPickImages={onPickImages} />);

    fireEvent.paste(screen.getByRole("textbox", { name: "Message composer" }), {
      clipboardData: {
        items: [{ kind: "file", type: "image/png" }],
        files: [image],
      },
    });

    expect(onPickImages).toHaveBeenCalledWith([image]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses clipboard items when a browser omits the clipboard files list", () => {
    const onPickImages = vi.fn();
    const image = new File(["image"], "safari-clipboard.png", {
      type: "image/png",
    });
    render(<PromptInput {...promptInputProps} onPickImages={onPickImages} />);

    fireEvent.paste(screen.getByRole("textbox", { name: "Message composer" }), {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ],
        files: [],
      },
    });

    expect(onPickImages).toHaveBeenCalledWith([image]);
  });

  it("does not paint a keyboard focus ring onto the first attach action after a pointer open", () => {
    render(<PromptInput {...promptInputProps} />);
    const trigger = screen.getByRole("button", { name: "Add to this message" });
    trigger.focus();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(
      screen.getByRole("button", { name: "Attach image" }),
    ).not.toHaveFocus();
    expect(trigger).not.toHaveFocus();
    expect(screen.getByText("Choose, paste, or drop")).toBeInTheDocument();
  });

  it("retains first-action focus when the add menu is opened from the keyboard", () => {
    render(<PromptInput {...promptInputProps} />);
    const trigger = screen.getByRole("button", { name: "Add to this message" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);

    expect(screen.getByRole("button", { name: "Attach image" })).toHaveFocus();
  });

  it("explains and enforces image capability limits", () => {
    const onPickImages = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="Send this"
        onPickImages={onPickImages}
        capabilities={{
          ...imageCapableAgent,
          supports_images: false,
        }}
        sendDisabled
        sendDisabledReason="The selected agent does not support image attachments."
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add to this message" }),
    );
    expect(screen.getByRole("button", { name: "Attach image" })).toBeDisabled();
    expect(screen.getByText("Not supported by this agent")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "The selected agent does not support image attachments.",
    );

    const textbox = screen.getByRole("textbox", { name: "Message composer" });
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    fireEvent.paste(textbox, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png" }],
        files: [image],
      },
    });
    expect(onPickImages).not.toHaveBeenCalled();
  });

  it("collapses back to the single-line height when the value is cleared externally", () => {
    let mockScrollHeight = 180;

    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return mockScrollHeight;
      },
    });

    const { rerender } = render(
      <PromptInput
        {...promptInputProps}
        value={"Line one\nLine two\nLine three"}
      />,
    );

    const textarea = screen.getByPlaceholderText(
      "Ask anything",
    ) as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("180px");

    mockScrollHeight = 52;

    rerender(<PromptInput {...promptInputProps} value="" />);

    expect(textarea.style.height).toBe("52px");
  });

  it("hosts the goal surface inside the plus menu", async () => {
    const onSetGoal = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        goal={{
          goal: null,
          provider: "codex",
          onSetGoal,
          onClearGoal: noop,
        }}
      />,
    );

    // Nothing goal-shaped until the plus menu is opened.
    expect(screen.queryByText("Set a goal")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Add to this message" }),
    );
    expect(screen.getByText("Attach image")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Set a goal"));
    const objective = screen.getByPlaceholderText(
      "e.g. All tests pass and lint is clean",
    );
    fireEvent.change(objective, { target: { value: "All tests pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Set goal" }));

    // The submit path is async (it awaits the host handler before closing).
    await waitFor(() =>
      expect(onSetGoal).toHaveBeenCalledWith("All tests pass", null),
    );
  });

  it("offers the built-in goal command for /goal and opens the goal surface", () => {
    const onValueChange = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="/goal"
        onValueChange={onValueChange}
        goal={{
          goal: null,
          provider: "codex",
          onSetGoal: noop,
          onClearGoal: noop,
        }}
      />,
    );

    const textarea = screen.getByPlaceholderText(
      "Ask anything",
    ) as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 5);
    fireEvent.click(textarea);

    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(screen.getByText("Set a goal to keep pursuing")).toBeInTheDocument();
    expect(screen.queryByText("No skills match /goal")).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("Goal"));

    expect(onValueChange).toHaveBeenCalledWith("");
    expect(
      screen.getByPlaceholderText("e.g. All tests pass and lint is clean"),
    ).toBeInTheDocument();
  });

  it("anchors slash suggestions above the composer without expanding it", () => {
    render(<PromptInput {...promptInputProps} value="/" />);

    const textarea = screen.getByPlaceholderText(
      "Ask anything",
    ) as HTMLTextAreaElement;
    textarea.setSelectionRange(1, 1);
    fireEvent.click(textarea);

    const emptyState = screen.getByText(/No skills match/);
    expect(emptyState.parentElement).toHaveClass("absolute", "bottom-full");
  });

  it("omits the goal entry from the plus menu when goals are unwired", () => {
    render(<PromptInput {...promptInputProps} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Add to this message" }),
    );
    expect(screen.getByText("Attach image")).toBeInTheDocument();
    expect(screen.queryByText("Set a goal")).not.toBeInTheDocument();
  });

  it("keeps new-thread controls enabled when sending is blocked but the composer is otherwise available", () => {
    render(
      <PromptInput
        {...promptInputProps}
        value="Draft message"
        showProviderSelector
        models={[
          {
            id: "gpt-5.4",
            label: "gpt-5.4",
            is_default: true,
            default_reasoning_effort: null,
            supported_reasoning_efforts: [],
          },
        ]}
        selectedModelId="gpt-5.4"
        sendDisabled
      />,
    );

    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
    const providerTrigger = screen.getByRole("combobox", { name: "Agent" });
    expect(providerTrigger).not.toBeDisabled();
    expect(providerTrigger).toHaveTextContent("Codex");
    expect(screen.getAllByRole("combobox")[0]).not.toBeDisabled();
  });

  it("shows Stop when a turn is running and the draft is empty", () => {
    const onStop = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value=""
        isRunning
        onStop={onStop}
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: [],
          permission_modes: [],
        }}
      />,
    );

    const stopButton = screen.getByRole("button", { name: "Stop generating" });
    expect(stopButton).toBeEnabled();
    stopButton.click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("delegates send, alternate follow-up, and newline to the host shortcut resolver", () => {
    const onSubmit = vi.fn();
    const onAlternateSubmit = vi.fn();
    const onValueChange = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="first line"
        onSubmit={onSubmit}
        onAlternateSubmit={onAlternateSubmit}
        onValueChange={onValueChange}
        resolveComposerShortcut={(event) => {
          if (event.key !== "Enter") return null;
          if (event.metaKey) return "alternate-submit";
          if (event.shiftKey) return "newline";
          return "submit";
        }}
      />,
    );

    const textarea = screen.getByPlaceholderText(
      "Ask anything",
    ) as HTMLTextAreaElement;
    textarea.setSelectionRange(5, 5);
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onAlternateSubmit).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("first\n line");
  });

  it("does not retain a hard-coded Enter send when the host unbinds it", () => {
    const onSubmit = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="draft"
        onSubmit={onSubmit}
        resolveComposerShortcut={() => null}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Ask anything"), {
      key: "Enter",
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not let slash completion consume a modified composer shortcut", () => {
    const onAlternateSubmit = vi.fn();
    render(
      <PromptInput
        {...promptInputProps}
        value="/review"
        skills={[
          {
            id: "review",
            label: "Review",
            alias: "review",
            availability: "both",
            providers: ["codex", "claude"],
            source_kind: "provider_native",
          },
        ]}
        onAlternateSubmit={onAlternateSubmit}
        resolveComposerShortcut={(event) =>
          event.metaKey && event.key === "Enter" ? "alternate-submit" : null
        }
      />,
    );
    const textarea = screen.getByPlaceholderText(
      "Ask anything",
    ) as HTMLTextAreaElement;
    textarea.setSelectionRange(7, 7);
    fireEvent.click(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onAlternateSubmit).toHaveBeenCalledOnce();
  });

  it("does not resolve shortcuts while an IME candidate is being composed", () => {
    const onSubmit = vi.fn();
    const resolveComposerShortcut = vi.fn(() => "submit" as const);
    render(
      <PromptInput
        {...promptInputProps}
        value="編集中"
        onSubmit={onSubmit}
        resolveComposerShortcut={resolveComposerShortcut}
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Message composer" }),
      {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
      },
    );

    expect(resolveComposerShortcut).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not repeat one-shot composer shortcuts while a key is held", () => {
    const onSubmit = vi.fn();
    const resolveComposerShortcut = vi.fn(() => "submit" as const);
    render(
      <PromptInput
        {...promptInputProps}
        value="send once"
        onSubmit={onSubmit}
        resolveComposerShortcut={resolveComposerShortcut}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Message composer" }),
      {
        key: "Enter",
        repeat: true,
      },
    );
    expect(resolveComposerShortcut).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("greys the capability pickers instead of dropping them, so the row keeps its shape", () => {
    const capabilities = {
      supports_review: false,
      supports_goals: false,
      supports_images: true,
      supports_skills: true,
      supports_interrupt: true,
      sandbox_modes: [],
      permission_modes: [],
    };

    const { rerender } = render(
      <PromptInput
        {...promptInputProps}
        capabilities={capabilities}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    );

    // Present but inert: an agent without these modes must not make the
    // composer reflow when the user switches to it.
    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Sandbox mode" }),
    ).toBeDisabled();

    rerender(
      <PromptInput
        {...promptInputProps}
        capabilities={{
          ...capabilities,
          permission_modes: ["default", "acceptEdits"],
          sandbox_modes: ["read-only"],
        }}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Sandbox mode" }),
    ).toBeEnabled();
  });

  it("orders the toggle row capability first, then the combined model menu", () => {
    render(
      <PromptInput
        {...promptInputProps}
        showProviderSelector
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: ["read-only"],
          permission_modes: ["default"],
        }}
        onPermissionModeChange={noop}
        onSandboxModeChange={noop}
      />,
    );

    expect(
      screen
        .getAllByRole("combobox")
        .map((element) => element.getAttribute("aria-label")),
    ).toEqual(["Agent", "Permission mode", "Sandbox mode"]);
    // Model, effort, and fast mode share one popover chip at the end of the row.
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();
  });

  it("exposes provider-native collaboration modes before the permission controls", () => {
    render(
      <PromptInput
        {...promptInputProps}
        collaborationModes={[
          {
            id: "default",
            label: "Default mode",
            mode: "default",
            model_id: null,
            reasoning_effort: null,
          },
          {
            id: "plan",
            label: "Plan mode",
            mode: "plan",
            model_id: null,
            reasoning_effort: "medium",
          },
        ]}
        selectedCollaborationMode="default"
        onCollaborationModeChange={noop}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Collaboration mode" }),
    ).toBeEnabled();
  });

  it("shows model and effort together on the model menu chip", () => {
    render(
      <PromptInput
        {...promptInputProps}
        models={[
          {
            id: "gpt-5.4",
            label: "gpt-5.4",
            is_default: true,
            default_reasoning_effort: null,
            supported_reasoning_efforts: [],
          },
        ]}
        selectedModelId="gpt-5.4"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveTextContent("gpt-5.4");
    expect(trigger).toHaveTextContent("Medium");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("menuitemradio", { name: "gpt-5.4" }),
    ).toHaveAttribute("aria-checked", "true");
    const effort = screen.getByRole("radio", { name: "Medium" });
    expect(effort).toHaveAttribute("aria-checked", "true");
  });

  it("filters a long model menu by label or provider identifier", () => {
    const models = Array.from({ length: 9 }, (_, index) => ({
      id:
        index === 8
          ? "openrouter/moonshotai:kimi-k2.6"
          : `openrouter/example:model-${index}`,
      label: index === 8 ? "Kimi K2.6" : `Example Model ${index}`,
      is_default: index === 0,
      default_reasoning_effort: null,
      supported_reasoning_efforts: [],
    }));
    render(<PromptInput {...promptInputProps} models={models} />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByRole("searchbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "moonshot kimi" } });

    expect(
      screen.getByRole("menuitemradio", { name: "kimi k2.6" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitemradio", { name: "example model 1" }),
    ).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "no-such-model" } });
    expect(screen.getByText("No models match “no-such-model”")).toBeInTheDocument();
  });

  describe("fast mode toggle", () => {
    const fastModel = {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      is_default: true,
      default_reasoning_effort: "medium",
      supported_reasoning_efforts: [],
      service_tiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      default_service_tier: null,
    };
    const plainModel = {
      id: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      is_default: false,
      default_reasoning_effort: "medium",
      supported_reasoning_efforts: [],
    };

    function openModelMenu() {
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
    }

    it("stays hidden while no model of the provider advertises a tier", () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={[plainModel]}
          selectedModelId={plainModel.id}
          onServiceTierChange={noop}
        />,
      );
      openModelMenu();
      expect(
        screen.queryByRole("menuitemcheckbox", { name: "Fast mode" }),
      ).not.toBeInTheDocument();
    });

    it("greys out for a model without a tier instead of unmounting", () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={[fastModel, plainModel]}
          selectedModelId={plainModel.id}
          onServiceTierChange={noop}
        />,
      );
      openModelMenu();
      expect(
        screen.getByRole("menuitemcheckbox", { name: "Fast mode" }),
      ).toBeDisabled();
    });

    it("reports the advertised tier id on toggle and null on toggle-off", () => {
      const onServiceTierChange = vi.fn();
      const { rerender } = render(
        <PromptInput
          {...promptInputProps}
          models={[fastModel]}
          selectedModelId={fastModel.id}
          selectedServiceTier={null}
          onServiceTierChange={onServiceTierChange}
        />,
      );

      openModelMenu();
      const toggle = screen.getByRole("menuitemcheckbox", {
        name: "Fast mode",
      });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      fireEvent.click(toggle);
      expect(onServiceTierChange).toHaveBeenLastCalledWith("priority");

      rerender(
        <PromptInput
          {...promptInputProps}
          models={[fastModel]}
          selectedModelId={fastModel.id}
          selectedServiceTier="priority"
          onServiceTierChange={onServiceTierChange}
        />,
      );
      expect(toggle).toHaveAttribute("aria-checked", "true");
      // The chip advertises the active tier with a filled bolt while the menu is open or closed.
      fireEvent.click(toggle);
      expect(onServiceTierChange).toHaveBeenLastCalledWith(null);
    });
  });

  it("keeps Send when a turn is running but the draft has content", () => {
    render(
      <PromptInput
        {...promptInputProps}
        value="Follow up"
        isRunning
        onStop={vi.fn()}
        capabilities={{
          supports_review: false,
          supports_goals: false,
          supports_images: true,
          supports_skills: true,
          supports_interrupt: true,
          sandbox_modes: [],
          permission_modes: [],
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generating" }),
    ).not.toBeInTheDocument();
  });

  describe("composer menu shortcuts", () => {
    const models = [
      {
        id: "haiku",
        label: "Haiku 4.5",
        is_default: false,
        default_reasoning_effort: null,
        supported_reasoning_efforts: [],
      },
      {
        id: "opus",
        label: "Opus 5",
        is_default: true,
        default_reasoning_effort: "high",
        supported_reasoning_efforts: [],
      },
      {
        id: "sonnet",
        label: "Sonnet 5",
        is_default: false,
        default_reasoning_effort: null,
        supported_reasoning_efforts: [],
      },
    ];

    it("navigates and selects with the keyboard while the caret stays in the draft", async () => {
      const onModelChange = vi.fn();
      render(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="opus"
          onModelChange={onModelChange}
          menuRequest={{ key: 1, menu: "model" }}
        />,
      );

      // Highlight starts on the selected model, not the top of the list.
      const opus = await screen.findByRole("menuitemradio", { name: "opus 5" });
      expect(screen.getByRole("menu")).toHaveAttribute(
        "aria-activedescendant",
        opus.id,
      );

      // The regression this covers: the packaged app leaves the caret in the
      // textarea when the shortcut opens the menu, so arrows are dispatched
      // there — not inside the popover — and must still drive the menu.
      fireEvent.keyDown(
        screen.getByRole("textbox", { name: "Message composer" }),
        { key: "ArrowDown" },
      );
      const sonnet = screen.getByRole("menuitemradio", { name: "sonnet 5" });
      await waitFor(() =>
        expect(screen.getByRole("menu")).toHaveAttribute(
          "aria-activedescendant",
          sonnet.id,
        ),
      );

      fireEvent.keyDown(document, { key: "Enter" });
      expect(onModelChange).toHaveBeenCalledWith("sonnet");
      await waitFor(() =>
        expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument(),
      );
    });

    it("wraps around the ends of the row list", async () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="haiku"
          menuRequest={{ key: 1, menu: "model" }}
        />,
      );
      await screen.findByRole("menuitemradio", { name: "haiku 4.5" });

      // Up from the first model lands on the last row — the effort group.
      fireEvent.keyDown(document, { key: "ArrowUp" });
      await waitFor(() =>
        expect(screen.getByRole("menu")).toHaveAttribute(
          "aria-activedescendant",
          screen.getByRole("radiogroup", { name: "Reasoning effort" }).id,
        ),
      );
    });

    it("adjusts reasoning effort with left and right on the effort row", async () => {
      const onEffortChange = vi.fn();
      render(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="opus"
          selectedEffort="medium"
          onEffortChange={onEffortChange}
          menuRequest={{ key: 1, menu: "model" }}
        />,
      );
      await screen.findByRole("menuitemradio", { name: "opus 5" });

      // Arrow down off the models (opus → sonnet → effort), then step within it.
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowDown" });
      await waitFor(() =>
        expect(screen.getByRole("menu")).toHaveAttribute(
          "aria-activedescendant",
          screen.getByRole("radiogroup", { name: "Reasoning effort" }).id,
        ),
      );

      fireEvent.keyDown(document, { key: "ArrowRight" });
      expect(onEffortChange).toHaveBeenCalledWith("high");

      // Left/Right only steer effort while that row is highlighted.
      onEffortChange.mockClear();
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "ArrowRight" });
      expect(onEffortChange).not.toHaveBeenCalled();
    });

    it("returns focus to the draft after closing a shortcut-opened menu", async () => {
      render(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="opus"
          menuRequest={{ key: 1, menu: "model" }}
        />,
      );

      await screen.findByRole("menuitemradio", { name: "opus 5" });
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "Message composer" }),
        ).toHaveFocus(),
      );
    });

    it("drops requests for unavailable menus without blocking later ones", async () => {
      // permission_modes is empty, so this request must be a no-op…
      const { rerender } = render(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="opus"
          menuRequest={{ key: 1, menu: "permissions" }}
        />,
      );
      expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();

      // …and must not strand the open state for the next request.
      rerender(
        <PromptInput
          {...promptInputProps}
          models={models}
          selectedModelId="opus"
          menuRequest={{ key: 2, menu: "model" }}
        />,
      );
      expect(
        await screen.findByRole("menuitemradio", { name: "opus 5" }),
      ).toBeInTheDocument();
    });
  });
});
