---
name: spec
description: Design a feature through conversation, producing a design doc at build/[feature]/spec.md. Right-sizes the doc to the task — a few lines for something simple, a fuller structured spec for something larger. Infers the feature directory from the conversation — no argument needed. Accepts a Linear ticket ref (e.g. DIS-123) as the argument to seed the design from the ticket and sync the finished spec back to it. Stops after the design is written — switch to plan mode for implementation planning.
argument-hint: "[feature-name | linear-ticket-ref] (optional)"
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(mkdir *), mcp__linear__get_issue, mcp__linear__list_comments, mcp__linear__save_issue
---

# /spec

Produce a feature design at `build/[feature]/spec.md`. Stop when the design is satisfactory — do not plan or implement. The user will switch to plan mode next.

**This is a requirements doc, not an implementation plan.** Its job is to specify *what* the feature must do and *why* — the behavior, constraints, and outcomes that define success — clearly enough that `/build` can take it from there. `/build` already owns the development planning: choosing files, functions, data structures, and the sequence of changes. So the design doc should not do that work. Describe the requirement, not the diff. When you find yourself enumerating specific files to edit or code to write, you've gone too far — pull back to the behavior that work needs to produce.

**Level the detail to the task.** A design doc is a tool, not a ceremony — its job is to capture exactly enough for `/build` to implement the feature well, and no more. Prefer the smallest doc that does that. A simple, well-understood change might need only a couple of sentences and a short bullet list; a large or subtle feature with real product decisions warrants the fuller structure below. Match the doc to the nature of the task so this process stays worth using for small work as well as large. Bias toward shorter: if a section isn't carrying a requirement, cut it.

The `[feature]` directory name is normally **inferred from the conversation**, not supplied as an argument. An argument, when given, is an explicit override — either a feature name or a **Linear ticket ref** (see Step 1).

## Step 1: Resolve the feature directory

- **If the first argument is a Linear ticket ref** — an issue identifier like `DIS-123` (team key, dash, number) or a Linear issue URL — this is **ticket mode**:
  1. Fetch the issue with `mcp__linear__get_issue` (and skim `mcp__linear__list_comments` for context that has accrued on the ticket).
  2. The ticket's title and description are the starting brief — base the conversation on them. In Step 2, open by summarizing your reading of the ticket and asking what the user wants to clarify, change, or add, rather than asking them to explain from scratch.
  3. Derive a short, descriptive kebab-case feature directory name from the ticket title, same as any other feature — e.g. DIS-123 "Make reads bounded" → `bounded-reads`. Don't embed the ticket id in the directory name; the ref lives inside the spec instead (Step 4). State the name so the user can correct it.
  4. If `build/[feature]/spec.md` already exists for that directory, read it, summarize, and iterate (Step 5).
  5. Ticket mode adds one obligation: when the design settles, **sync the finished spec back to the ticket** (Step 5). Carry the ticket ref through the session.
- **If an argument is provided and is not a ticket ref**, use it (kebab-cased) as the feature directory name. If `build/[feature]/spec.md` already exists, read it, give a brief summary, and ask the user what they'd like to change — then iterate (Step 5). Otherwise proceed to Step 2.
- **If no argument is provided**, don't pick a name yet — you'll infer it from the conversation in Step 3. Do not create any directory. Proceed to Step 2.

## Step 2: Discuss

Ask the user to explain what they're looking for. Have a conversation to understand requirements, constraints, and goals before writing anything.

In ticket mode, the ticket description already carries the initial requirements — lead with your summary of it and drive the discussion toward what's ambiguous, missing, or decision-shaped in the ticket.

Do NOT explore the codebase, draft the design doc, or create any directory yet. Wait for the user to explain and for any discussion to resolve.

## Step 3: Name the feature and check for an existing design

Once you understand what the user wants:

1. **Settle the directory name** (if it wasn't given as an argument). Derive a short, descriptive kebab-case name from the task description — e.g. "add a snooze button to todos" → `todo-snooze`. State the name you've chosen in one line so the user can correct it before you write anything.
2. **Check for an existing design** at `build/[feature]/spec.md`. If it exists, read it, summarize what's in it, and ask what they'd like to change — then iterate (Step 5) rather than drafting fresh.

## Step 4: Explore and draft

This step is for a **fresh** design. If `build/[feature]/spec.md` already existed (found in Step 1 or 3), skip it — the directory and doc are already there; go straight to Step 5 and iterate.

Once you understand what the user wants and have a name:

1. **Judge how much design the task actually needs.** Explore the codebase enough to write requirements that are grounded and unambiguous — to use the right names for existing concepts and to know what's already there — but scale that effort to the work. You're exploring to understand the problem, not to design the solution; resist drafting the implementation while you read.
2. Create the `build/[feature]/` directory and draft a design doc at `build/[feature]/spec.md`, **sized to the task**. Write it in terms of requirements — what the feature must do, how it should behave, what constraints and edge cases matter, and how you'd know it's done:
   - **Small / well-understood change** → keep it short. A sentence or two of intent plus a short bullet list of the required behavior is often the whole doc. Don't force in sections you have nothing to say under.
   - **Larger / subtle feature** → use the fuller structure:
     - **Overview**: what the feature does and why — the problem and the desired outcome
     - **Requirements**: the behavior it must exhibit, the constraints it must respect, and the edge cases it must handle. State the *what*, and the *why* where it isn't obvious; leave the *how* to `/build`.
     - **Open Questions**: anything that needs user input or further thought
   - Most tasks land in between — include the sections that earn their place and drop the rest.

In ticket mode, the spec must carry the ticket ref: put a `Ticket: [DIS-123](https://linear.app/...)` line directly under the H1, linking to the issue. This is what ties the spec back to Linear for `/build`, branch naming, and the description sync.

Where genuine product or architectural decisions exist — a real fork the implementer shouldn't be left to guess at — capture the decision and its rationale. That's a requirement, not an implementation detail. But don't pre-specify the routine mechanics: which files to touch, what to name a function, the shape of a helper. Point at the relevant area of the codebase for orientation when it helps (`convex/schema.ts`, "the todo row component"), rather than enumerating the edits to make.

### Format notes

The file is Markdown. Use standard Markdown — headings, lists, fenced code blocks, tables — and lean on it freely (tables for side-by-side comparisons, `<details>` for collapsible sections, fenced blocks for diagrams or code) when it clarifies the design. Don't add structure for its own sake; plain prose and lists are fine when that's all the content needs.

A short design might be as little as:

```md
# todo-snooze

Let users snooze a todo so it disappears from the active list until a time they pick, then reappears.

- Snoozing is per-todo and reversible — the user can un-snooze before the time passes.
- A snoozed todo is hidden from the active list but not completed or deleted.
- When the chosen time passes, the todo returns to the active list automatically.
- The snooze control lives on the todo itself and lets the user pick when it comes back.
```

Note what it does *not* say: no schema field, no component file, no filter logic. Those are `/build`'s to decide. The bullets are all behavior.

A fuller design uses headed sections:

```md
# [feature]

## Overview

...

## Requirements

- ...

## Open Questions

- ...
```

## Step 5: Iterate

Tell the user what you've drafted and ask for feedback. As they request changes, update `build/[feature]/spec.md` accordingly.

When the user is satisfied, stop. Suggest they switch to plan mode to continue.

### Ticket mode: sync the spec back to Linear

In ticket mode, once the design settles, update the Linear ticket so it carries the resolved spec — the ticket is the source of truth other flows (e.g. `/kickoff`) read from:

- Use `mcp__linear__save_issue` to replace the issue description with the final `spec.md` contents. The spec was grounded in the original description and supersedes it; Linear keeps description history, so nothing is lost. Omit the `Ticket:` line when syncing — it would be a self-reference inside the issue.
- Sync after the user signs off — not on every draft tweak. If the session resumes later and the spec changes again, re-sync on the next sign-off.
- If the sync fails (auth, permissions), say so explicitly and give the user the spec path so they can paste it — don't silently skip it.
