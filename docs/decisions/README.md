# Decision records

One short record per choice that shaped Loadline, and for anything that departs from `SPEC.md`. Each has the context, the decision, and what was rejected.

| # | Decision |
| --- | --- |
| [0001](0001-postgis-image-on-apple-silicon.md) | The PostGIS image on Apple Silicon |
| [0002](0002-library-versions.md) | Library versions at install time, and TypeScript 6 over 7 |
| [0003](0003-row-level-security-over-filters.md) | Row-level security over filters in application code |
| [0004](0004-temporal-constraints-over-application-check.md) | Temporal constraints over an application check |
| [0005](0005-stream-role-with-bypassrls.md) | The stream role with `BYPASSRLS` |
| [0006](0006-state-to-time-zone-approximation.md) | The state-to-time-zone approximation |
| [0007](0007-city-table-source.md) | The city table from TIGERweb instead of the Gazetteer files |
| [0008](0008-sql-migrations-and-drizzle-mirror.md) | Hand-written SQL migrations with a Drizzle mirror |
| [0009](0009-policies-apply-to-the-owner.md) | Policies apply to `loadline_owner` too, with two narrow exceptions |
| [0010](0010-system-role.md) | A fifth database-level role, `system`, for service writes |
