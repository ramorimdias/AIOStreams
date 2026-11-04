# Dynamic recommendation catalog names

Based on the official AIOStreams v2.37.0 release. This patch stores fetched recommendation names only as display hints (`upstreamName`). The `name` field is reserved for user overrides. Clearing the name field resumes upstream naming.

Legacy Favorite Genre/Theme placeholders are ignored during validation and manifest construction. Explicit renames are marked `nameIsCustom`, so deliberately chosen names remain supported. Refreshing the catalog list updates display hints without freezing dynamic upstream headings. Other catalog settings, ordering and IDs are preserved.

`Dockerfile.catalog-names` overlays the compiled core and setup UI on the exact official image retained as `aiostreams-before-catalog-fix:20261104`. It does not add the old personalized AIOStreams recommendation engine or tracker. Keep Watchtower disabled for this pinned patch until the fix is merged upstream or intentionally reapplied to a newer release.

Regression coverage: missing overrides, legacy placeholders, ordinary catalogs, custom names, and configuration save/re-save while changing catalog enablement.
