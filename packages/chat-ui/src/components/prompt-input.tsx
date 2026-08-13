import * as Popover from "@radix-ui/react-popover";
import {
  ChevronLeft,
  ImagePlus,
  Mic,
  Plug,
  Plus,
  Quote,
  Send,
  Square,
  Target,
  X,
} from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import type {
  ActiveSlashQuery,
  AgentCapabilitySummary,
  AgentProvider,
  CollaborationModeSummary,
  ImageInput,
  ModelSummary,
  ProviderOption,
  SkillSummary,
} from "@falcondeck/client-core";
import {
  activeSlashQuery,
  anyModelHasFastTier,
  canonicalSkillAlias,
  modelFastTier,
  NO_AGENT_CAPABILITIES,
  providerSupportsSkill,
  resolveServiceTier,
} from "@falcondeck/client-core";
import { ActivityDiamond, Button, cn } from "@falcondeck/ui";

import {
  ModelMenu,
  CollaborationModeSelector,
  PermissionModeSelector,
  ProviderSelector,
  SandboxSelector,
} from "./model-selector";
import {
  attachmentLabel,
  canRenderAttachmentImage,
} from "./attachment-preview";
import { GoalPanel, type GoalPanelProps } from "./goal-control";
import { isComposingKeyboardEvent } from "../lib/keyboard";
import type { QuotedSelection } from "../lib/quoted-selection";

/** Composer option menus that app-level shortcuts can open. */
export type ComposerMenu = "provider" | "permissions" | "sandbox" | "model";

export type ComposerMenuRequest = {
  /** Monotonic key so repeating the same menu shortcut re-opens it. */
  key: number;
  menu: ComposerMenu;
};

export type PromptInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** Sends with the opposite running follow-up behavior (Queue vs Steer). */
  onAlternateSubmit?: () => void;
  /** Host-owned shortcut resolver keeps product bindings out of shared UI. */
  resolveComposerShortcut?: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => "submit" | "alternate-submit" | "newline" | null;
  /** Interrupt the active turn. When set and the thread is running with an empty draft, the primary button becomes Stop. */
  onStop?: () => void;
  /** Opens a host-provided speech recorder when the composer is empty. */
  onVoiceInput?: () => void;
  onPickImages?: (files: FileList | readonly File[] | null) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  attachments: ImageInput[];
  /** Browser files currently being read into this conversation's attachments. */
  preparingAttachmentCount?: number;
  skills?: SkillSummary[];
  selectedProvider: AgentProvider;
  onProviderChange: (value: AgentProvider) => void;
  /** Providers the active workspace offers; defaults to the built-in pair. */
  providers?: ProviderOption[];
  /** Capabilities of the active provider; gates the mode pickers. */
  capabilities?: AgentCapabilitySummary;
  providerLocked?: boolean;
  showProviderSelector?: boolean;
  /** Cross-provider destinations shown behind the model menu's handoff step. */
  handoffProviders?: ProviderOption[];
  onHandoffProviderSelect?: (provider: AgentProvider) => void;
  handoffDisabledReason?: string | null;
  models: ModelSummary[];
  selectedModelId: string | null;
  onModelChange: (value: string) => void;
  reasoningOptions: string[];
  selectedEffort: string | null;
  onEffortChange: (value: string) => void;
  /**
   * Service tier id when fast mode is on; null runs the standard tier. The
   * toggle only mounts when a model of the current provider advertises a tier
   * and a handler is passed, so providers without the concept keep a clean row.
   */
  selectedServiceTier?: string | null;
  onServiceTierChange?: (value: string | null) => void;
  collaborationModes?: CollaborationModeSummary[];
  selectedCollaborationMode?: string | null;
  onCollaborationModeChange?: (value: string | null) => void;
  selectedPermissionMode?: string | null;
  onPermissionModeChange?: (value: string | null) => void;
  selectedSandboxMode?: string | null;
  onSandboxModeChange?: (value: string | null) => void;
  /**
   * Thread-creation choices (project, isolation, branch) rendered as a tab
   * docked above the composer. Hosts pass it only while no thread is selected;
   * all of those choices are fixed once the thread exists.
   */
  contextBar?: ReactNode;
  /**
   * Focuses the textarea whenever this changes to a non-null value. Hosts pass
   * a key that changes when a new conversation opens (and null while a thread
   * is selected) so the caret lands in the composer without stealing focus on
   * ordinary thread switches.
   */
  autoFocusKey?: string | null;
  /** Focus request for app-level shortcuts; unlike autoFocusKey it may repeat in an existing chat. */
  focusRequestKey?: number;
  /** Opens one of the option menus in response to an app-level shortcut. */
  menuRequest?: ComposerMenuRequest | null;
  /**
   * Rendered shortcut per option menu ("⌃⇧M"), surfaced in each chip's
   * tooltip. Hosts own the bindings, so the labels arrive from above rather
   * than being hardcoded here.
   */
  menuShortcuts?: Partial<Record<ComposerMenu, string>>;
  disabled?: boolean;
  sendDisabled?: boolean;
  /** Visible explanation when content exists but the host cannot send it. */
  sendDisabledReason?: string;
  /** True while the selected thread has an in-flight turn. */
  isRunning?: boolean;
  /** True while an interrupt request is in flight. */
  isStopping?: boolean;
  compact?: boolean;
  /** Enabled MCP servers for this workspace; renders a tools chip when > 0. */
  connectorCount?: number;
  onConnectorsClick?: () => void;
  /**
   * Thread goal wiring. When passed, the plus menu gains a Goal entry that
   * opens the set/clear surface in place. Hosts may create the thread lazily
   * from onSetGoal; omit only when the selected provider has no goal support.
   */
  goal?: Omit<GoalPanelProps, "onDone">;
  quotedSelections?: readonly QuotedSelection[];
  onRemoveQuotedSelection?: (selectionId: string) => void;
};

const PROMPT_INPUT_MIN_HEIGHT = 52;
const PROMPT_INPUT_MAX_HEIGHT = 200;

function partitionImageFiles(files: FileList | readonly File[]) {
  const selected = Array.from(files);
  return {
    images: selected.filter((file) => file.type.startsWith("image/")),
    unsupported: selected.filter((file) => !file.type.startsWith("image/")),
  };
}

function unsupportedAttachmentNotice(files: readonly File[]) {
  if (files.length === 1) {
    return `Only images can be attached right now. ${files[0]?.name || "That file"} was not attached.`;
  }
  return `Only images can be attached right now. ${files.length} non-image files were not attached.`;
}

const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: "codex", label: "Codex" },
  { provider: "claude", label: "Claude" },
];
const EMPTY_HANDOFF_PROVIDER_OPTIONS: ProviderOption[] = [];
const EMPTY_QUOTED_SELECTIONS: readonly QuotedSelection[] = [];
/** Stable default so an unset menuShortcuts never rebuilds optionMenuProps. */
const NO_MENU_SHORTCUTS: Partial<Record<ComposerMenu, string>> = {};

/** Keeps a disabled picker mounted when the host passes no handler for it. */
const noopModeChange = () => {};

export const PromptInput = memo(function PromptInput({
  value,
  onValueChange,
  onSubmit,
  onAlternateSubmit,
  resolveComposerShortcut,
  onStop,
  onVoiceInput,
  onPickImages,
  onRemoveAttachment,
  attachments,
  preparingAttachmentCount = 0,
  skills = [],
  selectedProvider,
  onProviderChange,
  providers = DEFAULT_PROVIDER_OPTIONS,
  capabilities = NO_AGENT_CAPABILITIES,
  providerLocked = false,
  showProviderSelector = true,
  handoffProviders = EMPTY_HANDOFF_PROVIDER_OPTIONS,
  onHandoffProviderSelect,
  handoffDisabledReason = null,
  models,
  selectedModelId,
  onModelChange,
  reasoningOptions,
  selectedEffort,
  onEffortChange,
  selectedServiceTier = null,
  onServiceTierChange,
  collaborationModes = [],
  selectedCollaborationMode = null,
  onCollaborationModeChange,
  selectedPermissionMode = null,
  onPermissionModeChange,
  selectedSandboxMode = null,
  onSandboxModeChange,
  contextBar,
  autoFocusKey = null,
  focusRequestKey = 0,
  menuRequest = null,
  menuShortcuts = NO_MENU_SHORTCUTS,
  disabled = false,
  sendDisabled = false,
  sendDisabledReason,
  isRunning = false,
  isStopping = false,
  compact = false,
  connectorCount = 0,
  onConnectorsClick,
  goal,
  quotedSelections = EMPTY_QUOTED_SELECTIONS,
  onRemoveQuotedSelection,
}: PromptInputProps) {
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const dragDepthRef = useRef(0);
  const plusMenuOpenedByKeyboardRef = useRef(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusMenuView, setPlusMenuView] = useState<"menu" | "goal">("menu");
  const [openOptionMenu, setOpenOptionMenu] = useState<ComposerMenu | null>(
    null,
  );
  const optionMenuOpenedByShortcutRef = useRef(false);
  // Seeded from the mount-time request: the composer remounts on
  // conversation/provider switches while the request state lives above it, so
  // a stale key must read as already-handled or every remount would replay
  // the last shortcut and pop its menu open.
  const handledMenuRequestKeyRef = useRef(menuRequest?.key ?? 0);
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [draggedFileKind, setDraggedFileKind] = useState<
    "images" | "unsupported" | "unknown" | null
  >(null);
  const [attachmentInputNotice, setAttachmentInputNotice] = useState<
    string | null
  >(null);
  const hasContent =
    value.trim().length > 0 ||
    attachments.length > 0 ||
    quotedSelections.length > 0;
  const isPreparingAttachments = preparingAttachmentCount > 0;
  const canAttachImages =
    Boolean(onPickImages) && capabilities.supports_images && !disabled;
  const canSubmit =
    hasContent && !disabled && !sendDisabled && !isPreparingAttachments;
  // Stop when a turn is running and there's nothing to send yet. Typing a follow-up
  // keeps Send so a later queue/steer path can use it; empty draft is the stop case.
  const showStop =
    Boolean(onStop) &&
    isRunning &&
    !hasContent &&
    capabilities.supports_interrupt;
  // Fast mode reads the tier off whichever model a send would actually use —
  // the explicit pick, or the provider default while nothing is picked yet.
  const selectedModel =
    models.find((model) => model.id === selectedModelId) ??
    models.find((model) => model.is_default) ??
    null;

  const filteredSkills = useMemo(() => {
    const query = slashQuery?.query.trim().toLowerCase() ?? "";
    const visibleSkills = skills.filter((skill) => {
      if (!query) return true;
      return (
        canonicalSkillAlias(skill.alias).includes(`/${query}`) ||
        skill.label.toLowerCase().includes(query) ||
        (skill.description ?? "").toLowerCase().includes(query)
      );
    });

    return visibleSkills.sort((left, right) => {
      const leftSupported = providerSupportsSkill(left, selectedProvider);
      const rightSupported = providerSupportsSkill(right, selectedProvider);
      if (leftSupported !== rightSupported) {
        return leftSupported ? -1 : 1;
      }
      return left.alias.localeCompare(right.alias);
    });
  }, [selectedProvider, skills, slashQuery?.query]);

  const showGoalCommand =
    Boolean(goal) &&
    "goal".includes(slashQuery?.query.trim().toLowerCase() ?? "");
  const slashSuggestionCount =
    filteredSkills.length + (showGoalCommand ? 1 : 0);

  useEffect(() => {
    setActiveSkillIndex(0);
  }, [slashQuery?.query]);

  useEffect(() => {
    setAttachmentInputNotice(null);
  }, [attachments]);

  // Attachment notices describe the provider/capability state at the moment
  // the file interaction happened. They must not survive an agent switch — a
  // Claude image-capable composer should never display a warning raised by a
  // previous provider.
  useEffect(() => {
    setAttachmentInputNotice(null);
    dragDepthRef.current = 0;
    setDraggedFileKind(null);
  }, [capabilities.supports_images, selectedProvider]);

  const syncTextareaHeight = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element) return;
      const previousScrollTop = element.scrollTop;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, PROMPT_INPUT_MAX_HEIGHT)}px`;
      // Collapsing to `auto` resets scroll position, and once the textarea is
      // pinned at max height the browser won't chase the caret on its own —
      // without this, a Shift+Enter newline lands below the visible area.
      const caretAtEnd =
        element.selectionStart === element.selectionEnd &&
        element.selectionEnd === element.value.length;
      element.scrollTop = caretAtEnd ? element.scrollHeight : previousScrollTop;
    },
    [],
  );

  useLayoutEffect(() => {
    syncTextareaHeight(textareaRef.current);
  }, [syncTextareaHeight, value]);

  useEffect(() => {
    if (autoFocusKey == null || disabled) return;
    textareaRef.current?.focus();
  }, [autoFocusKey, disabled]);

  useEffect(() => {
    if (focusRequestKey <= 0 || disabled) return;
    textareaRef.current?.focus();
  }, [disabled, focusRequestKey]);

  useEffect(() => {
    if (!menuRequest || menuRequest.key === handledMenuRequestKeyRef.current)
      return;
    handledMenuRequestKeyRef.current = menuRequest.key;
    if (disabled || compact) return;
    // A shortcut aimed at a picker that is hidden or empty must be dropped,
    // not queued: an unmounted picker never reports closing, which would
    // strand the open state and block every later menu shortcut.
    const available: Record<ComposerMenu, boolean> = {
      provider: showProviderSelector && !providerLocked && providers.length > 0,
      permissions:
        capabilities.permission_modes.length > 0 &&
        Boolean(onPermissionModeChange),
      sandbox:
        capabilities.sandbox_modes.length > 0 && Boolean(onSandboxModeChange),
      model: models.length > 0,
    };
    if (!available[menuRequest.menu]) return;
    optionMenuOpenedByShortcutRef.current = true;
    setOpenOptionMenu(menuRequest.menu);
  }, [
    capabilities.permission_modes,
    capabilities.sandbox_modes,
    compact,
    disabled,
    menuRequest,
    models.length,
    onPermissionModeChange,
    onSandboxModeChange,
    providerLocked,
    providers.length,
    showProviderSelector,
  ]);

  const optionMenuProps = useCallback(
    (menu: ComposerMenu) => ({
      shortcutHint: menuShortcuts[menu],
      open: openOptionMenu === menu,
      onOpenChange: (nextOpen: boolean) => {
        setOpenOptionMenu((current) =>
          nextOpen ? menu : current === menu ? null : current,
        );
        if (nextOpen) optionMenuOpenedByShortcutRef.current = false;
      },
      // Shortcut-opened menus hand focus back to the draft on close; Radix
      // would restore it to the trigger chip, which is never where typing
      // resumes. Pointer-opened menus keep the default restore.
      onCloseAutoFocus: (event: Event) => {
        if (!optionMenuOpenedByShortcutRef.current) return;
        optionMenuOpenedByShortcutRef.current = false;
        event.preventDefault();
        textareaRef.current?.focus();
      },
    }),
    [menuShortcuts, openOptionMenu],
  );

  const activeSkill =
    filteredSkills.length > 0 && (!showGoalCommand || activeSkillIndex > 0)
      ? (filteredSkills[
          Math.min(
            activeSkillIndex - (showGoalCommand ? 1 : 0),
            filteredSkills.length - 1,
          )
        ] ?? null)
      : null;
  const activeSkillSupported = activeSkill
    ? providerSupportsSkill(activeSkill, selectedProvider)
    : false;
  const goalCommandActive = showGoalCommand && activeSkillIndex === 0;

  const updateSlashQuery = useCallback(
    (nextValue: string, caretIndex?: number | null) => {
      if (disabled) {
        setSlashQuery(null);
        return;
      }
      const index =
        typeof caretIndex === "number"
          ? caretIndex
          : (textareaRef.current?.selectionStart ?? nextValue.length);
      setSlashQuery(activeSlashQuery(nextValue, index));
    },
    [disabled],
  );

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setAttachmentInputNotice(null);
    onPickImages?.(event.target.files);
    event.target.value = "";
  }

  function acceptPastedOrDroppedFiles(files: FileList | readonly File[]) {
    const { images, unsupported } = partitionImageFiles(files);
    setAttachmentInputNotice(
      unsupported.length > 0 ? unsupportedAttachmentNotice(unsupported) : null,
    );
    if (images.length > 0 && canAttachImages) onPickImages?.(images);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingKeyboardEvent(event)) return;
    if (event.repeat) return;

    const hasCommandModifier =
      event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
    if (slashQuery && slashSuggestionCount > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSkillIndex((current) => (current + 1) % slashSuggestionCount);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSkillIndex(
          (current) =>
            (current - 1 + slashSuggestionCount) % slashSuggestionCount,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashQuery(null);
        return;
      }
      if (
        !hasCommandModifier &&
        (event.key === "Tab" || event.key === "Enter") &&
        goalCommandActive
      ) {
        event.preventDefault();
        openGoalCommand();
        return;
      }
      if (
        !hasCommandModifier &&
        (event.key === "Tab" || event.key === "Enter") &&
        activeSkillSupported &&
        activeSkill
      ) {
        event.preventDefault();
        insertSkillAlias(activeSkill.alias);
        return;
      }
    }
    const shortcutAction = resolveComposerShortcut?.(event) ?? null;
    if (shortcutAction === "newline") {
      event.preventDefault();
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const nextValue = `${value.slice(0, start)}\n${value.slice(end)}`;
      onValueChange(nextValue);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(start + 1, start + 1);
      });
      return;
    }
    if (shortcutAction === "alternate-submit") {
      event.preventDefault();
      if (canSubmit) onAlternateSubmit?.();
      return;
    }
    if (shortcutAction === "submit") {
      event.preventDefault();
      if (canSubmit) onSubmit();
      return;
    }
    if (!resolveComposerShortcut && event.key === "Enter") {
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        // Cmd/Ctrl+Enter or Shift+Enter → insert newline (default textarea behavior)
        return;
      }
      // Plain Enter → submit
      event.preventDefault();
      if (canSubmit) {
        onSubmit();
      }
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const fileItems = Array.from(event.clipboardData.items).filter(
      (item) => item.kind === "file",
    );
    if (fileItems.length === 0) return;
    event.preventDefault();
    if (!canAttachImages) {
      setAttachmentInputNotice(
        capabilities.supports_images
          ? "Image attachments are unavailable right now."
          : "The selected agent does not support image attachments.",
      );
      return;
    }
    const clipboardFiles = Array.from(event.clipboardData.files);
    const pastedFiles =
      clipboardFiles.length > 0
        ? clipboardFiles
        : fileItems.flatMap((item) => {
            const file = item.getAsFile?.();
            return file ? [file] : [];
          });
    acceptPastedOrDroppedFiles(pastedFiles);
  }

  function draggedFilesKind(dataTransfer: DataTransfer) {
    const items = Array.from(dataTransfer.items ?? []).filter(
      (item) => item.kind === "file",
    );
    if (items.length === 0) return "unknown" as const;
    return items.some((item) => item.type.startsWith("image/"))
      ? ("images" as const)
      : ("unsupported" as const);
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggedFileKind(draggedFilesKind(event.dataTransfer));
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const kind = draggedFilesKind(event.dataTransfer);
    event.dataTransfer.dropEffect =
      canAttachImages && kind !== "unsupported" ? "copy" : "none";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDraggedFileKind(null);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggedFileKind(null);
    if (event.dataTransfer.files.length === 0) return;
    if (!canAttachImages) {
      setAttachmentInputNotice(
        capabilities.supports_images
          ? "Image attachments are unavailable right now."
          : "The selected agent does not support image attachments.",
      );
      return;
    }
    acceptPastedOrDroppedFiles(event.dataTransfer.files);
  }

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      onValueChange(nextValue);
      updateSlashQuery(nextValue, event.target.selectionStart);
      syncTextareaHeight(event.target);
    },
    [onValueChange, syncTextareaHeight, updateSlashQuery],
  );

  const insertSkillAlias = useCallback(
    (alias: string) => {
      const query = slashQuery;
      const textarea = textareaRef.current;
      if (!query || !textarea) return;
      const nextValue = `${value.slice(0, query.rangeStart)}${alias} ${value.slice(query.rangeEnd)}`;
      const nextCaret = query.rangeStart + alias.length + 1;
      onValueChange(nextValue);
      setSlashQuery(null);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
        updateSlashQuery(nextValue, nextCaret);
      });
    },
    [onValueChange, slashQuery, updateSlashQuery, value],
  );

  const openGoalCommand = useCallback(() => {
    const query = slashQuery;
    if (!query || !goal) return;
    onValueChange(
      `${value.slice(0, query.rangeStart)}${value.slice(query.rangeEnd)}`,
    );
    setSlashQuery(null);
    setPlusMenuView("goal");
    setPlusMenuOpen(true);
  }, [goal, onValueChange, slashQuery, value]);

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:mb-4 md:px-6 md:pt-3 md:pb-0">
      {contextBar}
      {/* `relative` keeps the card painting above the docked context bar tab. */}
      <div
        aria-busy={isPreparingAttachments}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "relative rounded-[var(--fd-radius-xl)] border bg-surface-2 shadow-[0_-2px_10px_-6px_rgba(0,0,0,0.14)] transition-colors",
          draggedFileKind === "images" && canAttachImages
            ? "border-accent bg-accent-dim"
            : "border-border-default",
        )}
      >
        {draggedFileKind ? (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-[var(--fd-radius-lg)] border border-dashed border-accent bg-surface-1/95 px-4 text-center text-[length:var(--fd-text-sm)] font-medium text-fg-primary shadow-[var(--fd-shadow-md)]"
          >
            {draggedFileKind === "unsupported"
              ? "Only images can be attached right now"
              : canAttachImages
                ? "Drop images to attach"
                : capabilities.supports_images
                  ? "Image attachments are unavailable right now"
                  : "The selected agent does not support image attachments"}
          </div>
        ) : null}
        {/* Attachment previews */}
        {attachments.length > 0 || isPreparingAttachments ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                {canRenderAttachmentImage(attachment.url) ? (
                  <img
                    src={attachment.url}
                    alt={attachment.name ?? "attachment"}
                    className="h-14 w-14 rounded-[var(--fd-radius-md)] border border-border-default object-cover"
                  />
                ) : (
                  <div
                    className="flex h-14 w-28 items-center rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2 text-[length:var(--fd-text-xs)] text-fg-secondary"
                    title={attachmentLabel(attachment)}
                  >
                    <span className="truncate">
                      {attachmentLabel(attachment)}
                    </span>
                  </div>
                )}
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    disabled={disabled}
                    className="fd-focus absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-default bg-surface-3 text-fg-secondary shadow-sm transition-colors hover:bg-surface-4 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
                    aria-label={`Remove ${attachment.name ?? "image attachment"}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
            {isPreparingAttachments ? (
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex min-h-14 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-3 text-[length:var(--fd-text-xs)] text-fg-secondary"
              >
                <ActivityDiamond size="md" />
                Preparing {preparingAttachmentCount}{" "}
                {preparingAttachmentCount === 1 ? "image" : "images"}…
              </div>
            ) : null}
          </div>
        ) : null}
        {quotedSelections.length > 0 ? (
          <div className="border-b border-border-subtle px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
              <Quote aria-hidden="true" className="h-3.5 w-3.5" />
              {quotedSelections.length} selected{" "}
              {quotedSelections.length === 1 ? "excerpt" : "excerpts"}
            </div>
            <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
              {quotedSelections.map((selection, index) => (
                <div
                  key={selection.id}
                  className="group/quote flex items-start gap-2 rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-3 px-3 py-2 shadow-sm"
                >
                  <blockquote className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap border-l-2 border-accent pl-2 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-secondary">
                    {selection.text}
                  </blockquote>
                  {onRemoveQuotedSelection ? (
                    <button
                      type="button"
                      onClick={() => onRemoveQuotedSelection(selection.id)}
                      aria-label={`Remove selected excerpt ${index + 1}`}
                      className="fd-focus inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-4 hover:text-fg-primary"
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Textarea */}
        <label htmlFor={textareaId} className="sr-only">
          Message composer
        </label>
        <textarea
          id={textareaId}
          ref={textareaRef}
          value={value}
          disabled={disabled}
          aria-label="Message composer"
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={() => updateSlashQuery(value)}
          onKeyUp={() => updateSlashQuery(value)}
          onPaste={handlePaste}
          placeholder={
            disabled ? "Add a project to get started..." : "Ask anything"
          }
          /* 16px on small screens keeps iOS Safari from zooming in on focus;
             drops to the standard body size once there is room. */
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary placeholder:text-fg-muted focus:outline-none md:text-[length:var(--fd-text-base)]"
          style={{
            minHeight: `${PROMPT_INPUT_MIN_HEIGHT}px`,
            maxHeight: `${PROMPT_INPUT_MAX_HEIGHT}px`,
          }}
          rows={1}
        />

        {attachmentInputNotice ? (
          <div className="flex items-center gap-2 px-4 pb-2 text-[length:var(--fd-text-xs)] text-warning">
            <p role="status" aria-live="polite" className="min-w-0 flex-1">
              {attachmentInputNotice}
            </p>
            <button
              type="button"
              onClick={() => setAttachmentInputNotice(null)}
              aria-label="Dismiss attachment message"
              className="fd-focus inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {slashQuery && !disabled ? (
          <div className="absolute right-3 bottom-full left-3 z-40 mb-2 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]">
            {slashSuggestionCount > 0 ? (
              <div className="max-h-64 overflow-y-auto py-1">
                {showGoalCommand ? (
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      openGoalCommand();
                    }}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left text-fg-primary transition-colors ${
                      goalCommandActive ? "bg-surface-3" : "hover:bg-surface-2"
                    }`}
                  >
                    <Target
                      className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[length:var(--fd-text-sm)] font-medium">
                        Goal
                      </div>
                      <div className="truncate text-[length:var(--fd-text-xs)] text-fg-secondary">
                        Set a goal to keep pursuing
                      </div>
                    </div>
                  </button>
                ) : null}
                {filteredSkills.map((skill, index) => {
                  const supported = providerSupportsSkill(
                    skill,
                    selectedProvider,
                  );
                  const active =
                    index + (showGoalCommand ? 1 : 0) === activeSkillIndex;
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      disabled={!supported}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (supported) {
                          insertSkillAlias(skill.alias);
                        }
                      }}
                      className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                        active ? "bg-surface-3" : "hover:bg-surface-2"
                      } ${supported ? "text-fg-primary" : "cursor-not-allowed text-fg-muted opacity-70"}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)]">
                          <span className="font-medium">{skill.alias}</span>
                          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-fg-muted">
                            {skill.source_kind.replace("_", " ")}
                          </span>
                        </div>
                        <div className="truncate text-[length:var(--fd-text-xs)] text-fg-secondary">
                          {skill.description ?? skill.label}
                        </div>
                      </div>
                      {!supported ? (
                        <span className="shrink-0 text-[length:var(--fd-text-xs)] text-fg-muted">
                          {selectedProvider} only unavailable
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
                No skills match{" "}
                <span className="font-medium">/{slashQuery.query}</span>
              </div>
            )}
          </div>
        ) : null}

        {sendDisabled && sendDisabledReason ? (
          <p
            id={`${textareaId}-send-status`}
            role="status"
            aria-live="polite"
            className="px-4 pb-2 text-[length:var(--fd-text-xs)] text-warning"
          >
            {sendDisabledReason}
          </p>
        ) : null}

        {/* Footer: tools + send */}
        <div className="flex items-center gap-1.5 px-3 pb-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            disabled={!canAttachImages}
            className="hidden"
            onChange={handleFileChange}
          />
          <Popover.Root
            open={plusMenuOpen}
            onOpenChange={(next) => {
              setPlusMenuOpen(next);
              // Always reopen on the menu, never on whatever view was last used.
              if (!next) setPlusMenuView("menu");
            }}
          >
            <Popover.Trigger asChild>
              <button
                ref={plusButtonRef}
                type="button"
                aria-label="Add to this message"
                onPointerDown={() => {
                  plusMenuOpenedByKeyboardRef.current = false;
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" ||
                    event.key === " " ||
                    event.key === "ArrowDown"
                  ) {
                    plusMenuOpenedByKeyboardRef.current = true;
                  }
                }}
                className="fd-focus inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary data-[state=open]:bg-surface-3 data-[state=open]:text-fg-secondary"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                side="top"
                sideOffset={8}
                onOpenAutoFocus={(event) => {
                  if (!plusMenuOpenedByKeyboardRef.current) {
                    event.preventDefault();
                    plusButtonRef.current?.blur();
                  }
                }}
                onCloseAutoFocus={(event) => {
                  if (!plusMenuOpenedByKeyboardRef.current) {
                    event.preventDefault();
                    plusButtonRef.current?.blur();
                  }
                  plusMenuOpenedByKeyboardRef.current = false;
                }}
                onPointerDown={() => {
                  plusMenuOpenedByKeyboardRef.current = false;
                }}
                className={cn(
                  "z-50 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]",
                  plusMenuView === "goal" ? "w-80 p-4" : "w-56 p-1",
                )}
              >
                {plusMenuView === "goal" && goal ? (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={() => setPlusMenuView("menu")}
                      className="fd-focus -ml-1 inline-flex items-center gap-1 rounded-[var(--fd-radius-sm)] px-1 py-0.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-secondary"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />{" "}
                      Back
                    </button>
                    <GoalPanel
                      {...goal}
                      onDone={() => setPlusMenuOpen(false)}
                    />
                  </div>
                ) : (
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => {
                        setPlusMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                      disabled={!canAttachImages}
                      aria-label="Attach image"
                      title={
                        capabilities.supports_images
                          ? undefined
                          : "The selected agent does not support image attachments"
                      }
                      className="fd-focus flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-secondary"
                    >
                      <ImagePlus
                        className="h-4 w-4 shrink-0 text-fg-muted"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block">Attach image</span>
                        {capabilities.supports_images ? (
                          <span
                            aria-hidden="true"
                            className="block text-[length:var(--fd-text-2xs)] text-fg-muted"
                          >
                            Choose, paste, or drop
                          </span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="block text-[length:var(--fd-text-2xs)] text-fg-muted"
                          >
                            Not supported by this agent
                          </span>
                        )}
                      </span>
                    </button>
                    {goal ? (
                      <button
                        type="button"
                        onClick={() => setPlusMenuView("goal")}
                        className="fd-focus flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary"
                      >
                        <Target
                          className="h-4 w-4 shrink-0 text-fg-muted"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {goal.goal ? goal.goal.objective : "Set a goal"}
                        </span>
                        {goal.goal ? (
                          <span className="shrink-0 rounded-full bg-accent-dim px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-accent">
                            On
                          </span>
                        ) : null}
                      </button>
                    ) : null}
                  </div>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>

          {/* Capability → mode → model → effort → switches. Permission scope
              leads because it is the toggle with consequences. */}
          {!compact ? (
            <>
              {showProviderSelector ? (
                <ProviderSelector
                  value={selectedProvider}
                  providers={providers}
                  onValueChange={onProviderChange}
                  disabled={disabled || providerLocked}
                  {...optionMenuProps("provider")}
                />
              ) : null}
              {collaborationModes.length > 0 ? (
                <CollaborationModeSelector
                  value={selectedCollaborationMode}
                  modes={collaborationModes}
                  onValueChange={onCollaborationModeChange ?? noopModeChange}
                  disabled={disabled || !onCollaborationModeChange}
                />
              ) : null}
              {capabilities.permission_modes.length > 0 ? (
                <PermissionModeSelector
                  value={selectedPermissionMode}
                  modes={capabilities.permission_modes}
                  onValueChange={onPermissionModeChange ?? noopModeChange}
                  disabled={disabled || !onPermissionModeChange}
                  {...optionMenuProps("permissions")}
                />
              ) : null}
              {capabilities.sandbox_modes.length > 0 ? (
                <SandboxSelector
                  value={selectedSandboxMode}
                  modes={capabilities.sandbox_modes}
                  onValueChange={onSandboxModeChange ?? noopModeChange}
                  disabled={disabled || !onSandboxModeChange}
                  {...optionMenuProps("sandbox")}
                />
              ) : null}
              <ModelMenu
                models={models}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                reasoningOptions={reasoningOptions}
                selectedEffort={selectedEffort}
                onEffortChange={onEffortChange}
                fastTier={modelFastTier(selectedModel)}
                fastActive={
                  resolveServiceTier(selectedServiceTier, selectedModel) !==
                  null
                }
                onFastActiveChange={
                  onServiceTierChange
                    ? (active) =>
                        onServiceTierChange(
                          active
                            ? (modelFastTier(selectedModel)?.id ?? null)
                            : null,
                        )
                    : undefined
                }
                showFastRow={
                  Boolean(onServiceTierChange) && anyModelHasFastTier(models)
                }
                handoffProviders={handoffProviders}
                onHandoffProviderSelect={onHandoffProviderSelect}
                handoffDisabledReason={handoffDisabledReason}
                disabled={disabled}
                {...optionMenuProps("model")}
              />
            </>
          ) : null}

          {!compact && connectorCount > 0 ? (
            <button
              type="button"
              onClick={onConnectorsClick}
              disabled={!onConnectorsClick}
              title={`${connectorCount} MCP server${connectorCount === 1 ? "" : "s"} available to agents in this workspace`}
              className={cn(
                "flex items-center gap-1 rounded-full border border-border-subtle px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted",
                onConnectorsClick &&
                  "hover:border-border-emphasis hover:text-fg-secondary",
              )}
            >
              <Plug className="h-3 w-3" aria-hidden="true" />
              {connectorCount}
            </button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {showStop ? (
              <Button
                type="button"
                onClick={onStop}
                disabled={disabled || isStopping}
                aria-label={isStopping ? "Stopping" : "Stop generating"}
                title={isStopping ? "Stopping…" : "Stop"}
                className="h-9 w-9 rounded-full p-0"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : onVoiceInput && !hasContent ? (
              <Button
                type="button"
                onClick={onVoiceInput}
                disabled={disabled}
                aria-label="Record voice input"
                title="Record voice input"
                className="h-9 w-9 rounded-full p-0"
              >
                <Mic className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                aria-label={
                  isPreparingAttachments ? "Preparing images" : "Send message"
                }
                aria-describedby={
                  sendDisabled && sendDisabledReason
                    ? `${textareaId}-send-status`
                    : undefined
                }
                className="h-9 w-9 rounded-full p-0"
              >
                {isPreparingAttachments ? (
                  <ActivityDiamond size="md" tone="current" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
