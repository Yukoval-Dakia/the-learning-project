# Domain Documentation Configuration

This project uses a **single-context** layout.

## Layout

- **Context file**: `CONTEXT.md` at repo root
- **ADR directory**: `docs/adr/` at repo root

## Consumer Rules

Skills that read domain documentation should:

1. Read `CONTEXT.md` to understand the project's domain language, key concepts, and terminology
2. Read ADRs from `docs/adr/` to understand past architectural decisions
3. Use this context to inform code generation, refactoring suggestions, and architectural improvements
4. Respect the established domain language when suggesting changes

## Current Status

- `CONTEXT.md`: Not yet created
- `docs/adr/`: Not yet created

## Existing Documentation

The project has extensive documentation in `docs/`:
- `docs/architecture.md` - Core architecture (knowledge graph, AI roles, artifacts, question bank, AI task layer)
- `docs/modules/` - Module-specific documentation (lanes, learning-items, mistakes, notes, progress, quiz)
- `docs/design/` - Design documentation

You can create `CONTEXT.md` to synthesize the domain language from these existing docs, and `docs/adr/` to capture architectural decisions over time.