import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { rankSlashSuggestions, type SkillSummary } from "@falcondeck/client-core";

import { SlashCommandMenu } from "./slash-command-menu";

const copyEditing: SkillSummary = {
  id: "skill:copy-editing",
  label: "Copy editing",
  alias: "/copy-editing",
  availability: "both",
  providers: ["codex"],
  source_kind: "project_file",
  description:
    "Edit, review, proofread, polish, tighten, or refresh existing marketing copy while preserving the core message.",
};

const freshEyes: SkillSummary = {
  id: "skill:fresh-eyes-review",
  label: "Fresh eyes review",
  alias: "/fresh-eyes-review",
  availability: "both",
  providers: ["codex"],
  source_kind: "project_file",
  description:
    "Reread recent code, catch obvious bugs/smells, and make focused cleanup fixes before handoff.",
};

describe("SlashCommandMenu", () => {
  it("highlights the ranked alias prefix and marks that row selected", () => {
    const items = rankSlashSuggestions({
      skills: [copyEditing, freshEyes],
      provider: "codex",
      query: "fresh",
    });
    render(
      <SlashCommandMenu
        query="fresh"
        items={items}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onSelect={vi.fn()}
        listId="slash-list"
      />,
    );

    const selected = screen.getByRole("option", { selected: true });
    expect(selected).toHaveTextContent("/fresh-eyes-review");
    expect(selected.querySelector("mark")).toHaveTextContent("fresh");
    expect(screen.queryByText("/copy-editing")).not.toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("does not move the highlight until the pointer actually moves", () => {
    const items = rankSlashSuggestions({
      skills: [copyEditing, freshEyes],
      provider: "codex",
      query: "",
    });
    const onActiveIndexChange = vi.fn();
    render(
      <SlashCommandMenu
        query=""
        items={items}
        activeIndex={0}
        onActiveIndexChange={onActiveIndexChange}
        onSelect={vi.fn()}
        listId="slash-list"
      />,
    );

    fireEvent.pointerEnter(screen.getByRole("option", { name: /fresh-eyes/i }));
    expect(onActiveIndexChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(screen.getByRole("listbox"));
    fireEvent.pointerEnter(screen.getByRole("option", { name: /fresh-eyes/i }));
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });

  it("shows a quiet empty state for an unmatched query", () => {
    render(
      <SlashCommandMenu
        query="zzzz"
        items={[]}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onSelect={vi.fn()}
        listId="slash-list"
      />,
    );
    expect(
      screen.getByText(/No commands or skills match/),
    ).toBeInTheDocument();
    expect(screen.getByText("/zzzz", { exact: false })).toBeInTheDocument();
  });
});
