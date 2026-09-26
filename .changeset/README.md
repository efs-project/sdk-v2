# Changesets

Per-package version intent, used by `@changesets/cli` (independent versions). While both
packages are private and unpublished (S0), changesets are **not required** on pull requests.
The release dry run only runs `changeset status`. `privatePackages.version` is on, so versioning
can be rehearsed; tags stay off until publishing is authorized.
