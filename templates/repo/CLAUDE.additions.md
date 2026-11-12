<!--
Suggested ADDITIONS to your repo's CLAUDE.md for working with the dw plugin. Paste the sections you need;
keep the whole file short (about a page). Replace every FILL-IN with real values. Remove this comment block.
Machine-readable commands for dw (build/test/lint/format, test globs) live in .claude/dw.json; run /dw:setup-repo to create it.
-->

## Commands
- Build: `FILL-IN` (e.g. `npm run build`, `dotnet build`).
- Fast build/type-check while coding: `FILL-IN` (e.g. `npx tsc --noEmit`, `dotnet build <project>`).
- All tests: `FILL-IN`.
- One test file / one test: `FILL-IN` (e.g. `npx vitest run <file> -t "<name>"`, `dotnet test --filter "FullyQualifiedName~<Class>.<Method>"`).
- Lint / format check (changed files): `FILL-IN`.
- FILL-IN: any package or project that needs a different command.

## Tests
- Test levels used here and what each covers: FILL-IN (e.g. unit = no I/O; integration = real database in a container).
- Where tests live and how they are named: FILL-IN.
- Shared fakes/builders/fixtures to reuse: FILL-IN.

## Verification before commit / PR
Run the build and the tests of every touched area before reporting a task complete, and include the result line.
If a test fails, fix the code, not the test. A test written to reproduce a bug is never edited to make it pass.

## Things Claude gets wrong here
<!-- FILL-IN as they happen: "When Claude makes a mistake twice, the correction goes here." -->
- FILL-IN
