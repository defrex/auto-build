# Observations

## Unbounded collect in the dashboard query

- **kind:** perf
- **where:** apps/web/convex/dashboard/getDashboard.ts:31
- **why out of scope:** dashboard reads were not part of this build
- **suggestion:** cap the read with `.take(n)` and denormalize the count
