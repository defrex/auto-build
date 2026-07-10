---
name: spec
description: Design a feature through conversation and capture it as a Linear ticket. Running /spec always means a Linear ticket should exist when you're done — pass a ticket ref (e.g. DIS-123) to work on that ticket, or pass nothing and the agent creates one in the Product team's Triage. Right-sizes the design to the task. Tickets that aren't fully defined get a needs-definition label; fully-defined ones don't. Stops after the design is written — switch to plan mode for implementation planning.
argument-hint: "[linear-ticket-ref] (optional)"
user-invocable: true
allowed-tools: Read, Glob, Grep, mcp__linear__get_issue, mcp__linear__list_comments, mcp__linear__list_issue_labels, mcp__linear__save_issue
---

# /spec

`/spec` designs a feature through conversation and captures the result as a **Linear ticket**. Running `/spec` always means a Linear ticket should exist when the design settles — either the one you were handed, or one you create. There is **no local file**: the ticket *is* the spec, and it's the source of truth other flows (`/kickoff`, `/build`) read from.

Produce a design and **stop when it's satisfactory — do not plan or implement.** The user will switch to plan mode next.

Two entry points, one destination:

- **Ticket given** — the argument is a Linear ticket ref (e.g. `DIS-123` or a Linear issue URL). Work on that ticket; its title and description are the starting brief.
- **No ticket** — generate one. Anything you're handed that isn't a ticket ref (a feature name, a sentence of intent) is just the seed topic for the conversation. You'll **create the ticket in the Product team's Triage** when the design settles.

**This is a requirements doc, not an implementation plan.** Its job is to specify *what* the feature must do and *why* — the behavior, constraints, and outcomes that define success — clearly enough that `/build` can take it from there. `/build` already owns the development planning: choosing files, functions, data structures, and the sequence of changes. So the design should not do that work. Describe the requirement, not the diff. When you find yourself enumerating specific files to edit or code to write, you've gone too far — pull back to the behavior that work needs to produce.

**Level the detail to the task.** A design is a tool, not a ceremony — its job is to capture exactly enough for `/build` to implement the feature well, and no more. Prefer the smallest description that does that. A simple, well-understood change might need only a couple of sentences and a short bullet list; a large or subtle feature with real product decisions warrants the fuller structure below. Bias toward shorter: if a section isn't carrying a requirement, cut it.

## Step 1: Resolve the target

- **If the first argument is a Linear ticket ref** — an issue identifier like `DIS-123` (team key, dash, number) or a Linear issue URL — you're working on that **existing** ticket.
  1. Fetch it with `mcp__linear__get_issue`, and skim `mcp__linear__list_comments` for context that has accrued on the ticket.
  2. **Note its current labels and current state** — you'll need both in Step 5 (`save_issue` replaces the label set, so you must pass the full desired set).
  3. The ticket's title and description are the starting brief. In Step 2, open by summarizing your reading of the ticket and asking what the user wants to clarify, change, or add — don't make them explain from scratch.
- **If no argument is provided, or the argument is not a ticket ref** — you're creating a **new** ticket. Treat any non-ref argument as the seed topic for the conversation. **Do not create the ticket yet** — carry the topic into Step 2; you'll create the issue in Step 5 once the design has taken shape.

## Step 2: Discuss

Ask the user to explain what they're looking for. Have a conversation to understand requirements, constraints, and goals before writing anything.

For an existing ticket, the description already carries the initial requirements — lead with your summary of it and drive the discussion toward what's ambiguous, missing, or decision-shaped.

Do NOT explore the codebase or draft the design yet. Wait for the user to explain and for any discussion to resolve.

## Step 3: Explore and draft

Once you understand what the user wants:

1. **Judge how much design the task actually needs.** Explore the codebase enough to write requirements that are grounded and unambiguous — to use the right names for existing concepts and to know what's already there — but scale that effort to the work. You're exploring to understand the problem, not to design the solution; resist drafting the implementation while you read.
2. Draft the design **as the content of the ticket description**, sized to the task (see Format notes). Write it in terms of requirements — what the feature must do, how it should behave, what constraints and edge cases matter, and how you'd know it's done. Keep the working draft in the conversation while you iterate; there is no local file.
   - **Small / well-understood change** → keep it short. A sentence or two of intent plus a short bullet list of the required behavior is often the whole thing. Don't force in sections you have nothing to say under.
   - **Larger / subtle feature** → use the fuller structure:
     - **Overview**: what the feature does and why — the problem and the desired outcome
     - **Requirements**: the behavior it must exhibit, the constraints it must respect, and the edge cases it must handle. State the *what*, and the *why* where it isn't obvious; leave the *how* to `/build`.
     - **Open Questions**: anything that needs user input or further thought (these also drive the `needs-definition` call in Step 5)
   - Most tasks land in between — include the sections that earn their place and drop the rest.

Where genuine product or architectural decisions exist — a real fork the implementer shouldn't be left to guess at — capture the decision and its rationale. That's a requirement, not an implementation detail. But don't pre-specify the routine mechanics: which files to touch, what to name a function, the shape of a helper. Point at the relevant area of the codebase for orientation when it helps (`convex/schema.ts`, "the todo row component") rather than enumerating the edits to make.

### Format notes

The ticket description renders Markdown. Use standard Markdown — headings, lists, fenced code blocks, tables — and lean on it freely (tables for side-by-side comparisons, `<details>` for collapsible sections, fenced blocks for diagrams or code) when it clarifies the design. Don't add structure for its own sake; plain prose and lists are fine when that's all the content needs.

**Don't open the description with an H1 title** — the ticket already has a title. Start at the first section (e.g. `## Overview`) or with the intro prose. And **don't add a `Ticket:` self-reference line** — the issue already is the source of truth.

A short design might be as little as:

```md
Let users snooze a todo so it disappears from the active list until a time they pick, then reappears.

- Snoozing is per-todo and reversible — the user can un-snooze before the time passes.
- A snoozed todo is hidden from the active list but not completed or deleted.
- When the chosen time passes, the todo returns to the active list automatically.
- The snooze control lives on the todo itself and lets the user pick when it comes back.
```

Note what it does *not* say: no schema field, no component file, no filter logic. Those are `/build`'s to decide. The bullets are all behavior.

A fuller design uses headed sections:

```md
## Overview

...

## Requirements

- ...

## Open Questions

- ...
```

## Step 4: Iterate

Tell the user what you've drafted and ask for feedback. As they request changes, update the working draft accordingly.

When the user is satisfied, go to Step 5 and write the ticket. Don't write to Linear on every draft tweak — do it once the design settles (and again on each later sign-off if the session resumes and the design changes).

## Step 5: Write the ticket to Linear

The ticket is the artifact `/spec` produces. Once the design settles:

### Assess whether the issue is fully defined

A ticket is **fully defined** when its requirements are clear and unambiguous enough that `/build` could implement them without further product input — no open decisions, no "we'll figure this out later," nothing a human still has to resolve. If unresolved **Open Questions** or decision-shaped gaps remain, it is **not** fully defined.

This drives one label, `needs-definition`:

- **Not fully defined** → the ticket carries `needs-definition`. Keep the open questions in the description so the gap is visible. (`/kickoff` skips Ready issues with this label, so it won't be picked up until a human fleshes it out.)
- **Fully defined** → the ticket must **not** carry `needs-definition` — don't add it on a fresh ticket, and remove it from an existing one.

If you need the label's id, look it up with `mcp__linear__list_issue_labels`; `save_issue` also accepts label names directly.

### New ticket

Create it with `mcp__linear__save_issue`:

- `team`: `"Product"`
- `state`: `"Triage"` — new tickets land in Triage by default
- `title`: a short, descriptive title
- `description`: the final design (no H1, no `Ticket:` line)
- `labels`: include `"needs-definition"` **only if** the issue is not fully defined (per the assessment above); otherwise omit it

Report the created issue's identifier and URL back to the user.

### Existing ticket

Update it with `mcp__linear__save_issue` (pass the issue `id`):

- **Replace the description** with the final design. The design was grounded in the original description and supersedes it; Linear keeps description history, so nothing is lost.
- **Set the label set.** `save_issue` replaces labels wholesale, so pass the ticket's current labels (captured in Step 1) and then add or drop `needs-definition` according to the assessment above. Leave the ticket's state as-is unless the user asks to move it.

### Either way

- Do this after the user signs off — not on every draft tweak. If the session resumes later and the design changes again, re-write on the next sign-off.
- If the write fails (auth, permissions), say so explicitly and give the user the full design text so they can paste it into Linear themselves — don't silently skip it.

When the ticket is written, stop. Suggest the user switch to plan mode to continue.
