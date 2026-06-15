# Observations

## Unbounded collect in widget loader

- **kind:** perf
- **where:** apps/web/convex/widgets/loadWidgets.ts:12
- **why out of scope:** the build only touched the widget editor UI
- **suggestion:** paginate the widgets query instead of `.collect()`

## Missing test for the slug parser

- **kind:** test-gap
- **where:** apps/web/src/lib/utils/parse-slug.ts:8
- **why out of scope:** parser behavior predates this feature
- **suggestion:** add table-driven cases for unicode and empty input
