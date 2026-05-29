# ADR-0002: Release tag policy (no GPG signing, version-only tag body)

## Status

Accepted

## Context

Releases are driven by `npm version`, which creates an annotated git tag
`vX.Y.Z` whose body is just the version string, and a push of that tag triggers
`.github/workflows/npm-publish.yml`. Two properties of these tags were raised in
review:

- The tags are not GPG-signed (`git tag -v` shows no signature block).
- The tag body duplicates only the version number; the substantive release
  notes live in `CHANGELOG.md` and the GitHub Release.

Both are supply-chain / provenance concerns. The relevant mitigations already in
place: npm publishing uses `--provenance` via OIDC trusted publishing, and the
publish workflow creates a GitHub Release that references the CHANGELOG entry for
the tag.

## Decision

We will keep release tags unsigned and keep the tag body as the bare version
string.

- Provenance of published artifacts is established by npm provenance (OIDC),
  which covers the consumer-facing supply chain. GPG-signing tags is therefore
  optional, not required.
- Release notes have a single source of truth: `CHANGELOG.md`, surfaced through
  the GitHub Release. Embedding notes in the tag body would duplicate them.

Contributors who want stronger tag provenance MAY sign release tags locally with
`git tag -s vX.Y.Z` (requires a configured GPG/SSH signing key); this is allowed
but not enforced by the release process or CI.

## Consequences

- The release flow stays a two-command operation (`npm version` +
  `git push --follow-tags`) with no key-management prerequisite.
- Tag provenance relies on GitHub account and branch protections plus npm
  provenance rather than on per-tag cryptographic signatures.
- If a future requirement demands verifiable tag signatures (e.g. an enterprise
  consumer policy), this decision is superseded by a new ADR that adds `git tag
  -s` to the release procedure and signature verification to CI.
