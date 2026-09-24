# Domain docs

This repository uses a **single-context** layout: a root `CONTEXT.md` for domain vocabulary and `docs/adr/` for architectural decisions. `docs/adr/README.md` describes the ADR convention.

## Before exploring

Read `CONTEXT.md`, then the ADRs in `docs/adr/` that concern the area being explored.

The `domain-modeling` skill adds terms and ADRs as terminology and decisions are resolved; record only resolved terms and decisions, never placeholders.

Designs and behavior live in `docs/architecture/` and the guides indexed in `docs/README.md`. Follow the pointers in `AGENTS.md` for the relevant area.

## Vocabulary

Use the glossary's terms when naming domain concepts in issues, proposals, hypotheses and tests. If a needed concept is missing, first check whether an existing term applies; otherwise record the gap for `domain-modeling`.

## Decisions

Surface any conflict with an existing ADR explicitly, identifying the decision and explaining why it should be revisited. Preserve the current decision until a replacement is agreed.
