# Source publication review

Review date: 2026-11-05. Scope: local Git refs through backend commit `abb56cd`, the current publishable working tree, the integrated `frontend/`, ignore rules and the backend npm export. This is a focused source/privacy check, not a legal opinion, full application security audit or guarantee that every possible secret can be detected.

## Checks and outcome

- Gitleaks 8.30.1 with default rules, full redaction and all locally available refs: 44 commits scanned; no credential findings. No credential verification or external service was contacted.
- A separate scan of 411 reachable historical file blobs checked for local filesystem paths, private IPv4 ranges, internal hostnames and email addresses in content. No private IPv4 addresses or email addresses were found in historical file contents. Git author metadata was reviewed separately.
- A Git-filtered publication snapshot includes tracked files plus non-ignored untracked frontend files, excluding environment overrides, dependencies, generated output, private notes and browser traces. Gitleaks found no credentials in that snapshot. The post-integration scan was repeated against the final files.
- Examples containing a dummy credential URL/email are deliberate rejection fixtures in `frontend/test/model.test.ts`, not real credentials. Synthetic session tokens and placeholder keys in tests are not live authentication values.
- Public provider API domains, service-name examples, repository URLs and attribution are intentional public references. The concrete Kubernetes namespace was removed from the MCP endpoint example.
- Local environment files and manual observations remain on disk but are ignored. The root ignore rules now exclude every non-example environment file and all of `docs/private/`, including captured JSON. The frontend additionally excludes its private notes, environment, browser output and build artifacts.
- `scripts/verify-package.mjs` checks Git publication paths as well as the npm file list. The backend npm package excludes frontend tooling and private artifacts. The combined root Dockerfile uses a context whose ignore rules exclude nested environment files, private notes, Git metadata and generated artifacts; its runtime copies only compiled backend output/dependencies and built static frontend assets.

## Historical information still visible

A historical agent-metadata file, `.claude-flow/neural/patterns.json`, contains absolute workstation paths. That file appears in the older history around commits `e95318c` / `d7a46ca` and is already absent from the current tracked tree. It is not a credential finding, but it is an environment/privacy disclosure in existing history. A current-file deletion or `.gitignore` rule cannot remove historical blobs.

The history also preserves earlier internal Service endpoint examples. Current public documentation uses a generic endpoint. Git commits retain the author's name/email and dependency-bot attribution; this review does not anonymize identities or rewrite commits.

No Git history, remote ref, tag or published artifact was rewritten or removed. If historical path/identity removal is required, decide that separately before coordinating a history rewrite and replacement of remote refs. Existing clones, forks and cached artifacts may retain old content even after such a rewrite. No credential rotation is indicated solely by a workstation path; a real credential finding would require a separate response.

## Reproduce locally

Install Gitleaks through a trusted package source if it is not already available. Run from the repository root and keep reports outside the repository or inside ignored `docs/private/`. Reports below are fully redacted. Do not upload ignored folders manually.

```sh
gitleaks git --log-opts=--all --redact=100 --no-banner .
node scripts/verify-package.mjs
git status --short --untracked-files=all
git check-ignore .env frontend/.env.local docs/private/review.hide.md frontend/docs/private/review.hide.md
```

The Git history scanner does not cover new untracked frontend source until it is committed. Include Git-filtered untracked files in a separate directory scan before publication; do not scan only the staged diff and claim that history was checked. This review performed that separate directory scan as well. Files intentionally ignored can contain private local evidence and are not part of a normal `git add`/push or backend npm export.

The scan covers locally available refs, not deleted/unfetched remote refs, remote caches, forks, prior release assets or every possible encoded secret format. Publishing this repository does not host a live website; the existing CI/container workflows are separate automation and should be reviewed before a future push. No commit, push, release or deployment was performed during this review.
