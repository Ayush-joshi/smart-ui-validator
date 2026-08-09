# Publishing Smart UI Validator to npm

## Status

This is the release runbook for publishing the host-neutral engine, CLI, and stdio MCP server. It
does not authorize publication. Publishing remains a separate release-owner action after the
repositories are public and every gate below passes.

Current blockers:

1. Select a Smart UI Validator license, add the root `LICENSE`, and add its SPDX identifier to each
   published package manifest.
2. Publish Agent Memory and replace the current GitHub commit dependency in
   `packages/core/package.json` with its exact npm package name and reviewed semver version.
3. Confirm that the release owner controls the `@smart-ui` npm user or organization scope. The
   package names are absent from the registry, but name absence does not grant scope ownership.
4. Make both GitHub repositories public before enabling provenance-based trusted publishing. npm
   does not generate provenance for packages built from private repositories.

Run `pnpm publish:check` to see the remaining local blockers.

## Intended public packages

| Package                | Source            | Purpose                                     | Depends on                                               |
| ---------------------- | ----------------- | ------------------------------------------- | -------------------------------------------------------- |
| `@smart-ui/core`       | `packages/core`   | Host-neutral engine and provider contracts  | Published Agent Memory package, Playwright, Zod          |
| `@smart-ui/cli`        | `apps/cli`        | `smart-ui` command                          | Compatible `@smart-ui/core` release                      |
| `@smart-ui/mcp-server` | `apps/mcp-server` | `smart-ui-mcp` stdio command and server API | Compatible `@smart-ui/core` release and official MCP SDK |

The workspace root stays `private: true`. Fixtures, tests, evaluation inputs, repository scripts,
and the root package must never be published. All three packages use one version so a CLI or MCP
schema cannot silently target an incompatible core.

## Agent Memory handoff

Publish Agent Memory first. Then provide:

```text
Package name:  e.g. @scope/agent-memory
Version:       e.g. 0.4.0
npm URL:       https://www.npmjs.com/package/@scope/agent-memory
Source tag:    e.g. v0.4.0
Integrity:     npm view @scope/agent-memory@0.4.0 dist.integrity
Exports:       confirmation that VectorStore, TdaiCore, StandaloneHostAdapter, and parseConfig remain public
```

Smart UI should initially pin the exact reviewed version:

```json
{
  "dependencies": {
    "@scope/agent-memory": "0.4.0"
  }
}
```

Update the TypeScript import specifier only if the published package name differs. After the first
compatible release is proven, a patch-compatible range may be considered. Do not use `latest`, a
Git branch or commit, HTTP tarball, `file:`, or `link:` in a published production manifest.

## Scope decision

The current public names use `@smart-ui`. Before publishing:

```bash
npm login
npm whoami
npm access list packages @smart-ui
```

The logged-in user must own the matching npm user scope or have publish permission in the matching
npm organization. If the project does not control `@smart-ui`, choose the final scope before the
first release and rename all three packages together. A safe alternative is a product-specific
organization such as `@smart-ui-validator`.

Do not publish under a temporary name. Package names become part of public imports, generated host
configuration, desktop manifests, dependency graphs, provenance, and user trust.

## License decision

Public GitHub and npm visibility do not grant a license. The owner must select one deliberately:

1. Add its complete text at repository root as `LICENSE`.
2. Add the same SPDX identifier to all three publishable package manifests.
3. Retain third-party notices required by bundled dependencies.
4. Run `pnpm publish:check` again.

Do not copy Agent Memory's MIT license unless MIT is also the deliberate Smart UI decision.

## Public-source checklist

Before changing either GitHub repository to public:

- Review tracked and untracked files and the relevant Git history.
- Run the secret scanner and rotate credentials that may have existed while the repository was
  private.
- Review screenshots, fixtures, designs, logs, reports, and SBOMs for customer or personal data.
- Confirm contributor and upstream license obligations.
- Add a private security-reporting path.
- Enable branch protection and required checks on `main`.
- Confirm Actions do not upload private source or credentials to third parties.

Making a repository public and publishing an npm package are separate, separately reviewed actions.

## Version preparation

For a release `X.Y.Z`:

1. Confirm Agent Memory's published version and integrity.
2. Update the root, core, CLI, and MCP versions to the same `X.Y.Z`.
3. Update `CHANGELOG.md` and compatibility documentation.
4. Install from the frozen lockfile in a clean checkout.
5. Install the pinned Chromium revision.
6. Run every repository gate.
7. Run `pnpm publish:check` after the build.
8. Inspect packed manifests and tarball file lists.
9. Test the tarballs without workspace symlinks.
10. Commit and tag `vX.Y.Z` only after the evidence passes.

Never rebuild and publish the same version from a later commit.

## Required verification

```bash
pnpm install --frozen-lockfile
pnpm --filter @smart-ui/core exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm evaluate
pnpm security:secrets
pnpm package:check
pnpm publish:check
pnpm audit --prod --audit-level high
pnpm sbom
```

Browser E2E tests and the Agent Memory persistence canary remain required even though npm consumers
normally enter through the CLI or MCP adapter.

## Consumer dependency behavior

The published packages intentionally do not download Chromium from an npm `postinstall` script.
`npm install` installs the JavaScript packages and Agent Memory's supported native dependency, but
browser provisioning is an explicit supported step:

```bash
npm install --save-dev @smart-ui/cli@X.Y.Z
npx smart-ui setup --target . --agent-memory
npx smart-ui doctor --target .
```

This separation keeps package installation predictable behind offline proxies and prevents a large
runtime download from making the package transaction fail. `smart-ui setup` resolves the
package-local Playwright CLI, installs the exact compatible Chromium revision without a shell or
global package manager, performs a real launch canary, and exits `4` if readiness fails.

Agent Memory uses Node's embedded `node:sqlite` plus its npm native dependency. Consumers do not
install a SQLite server or executable. Node older than 22.16 is unsupported. The Agent Memory
canary is optional unless the target configuration enables the `agent-memory` backend.

## Candidate tarballs

Use the tag-driven release-candidate workflow or build locally:

```bash
mkdir -p release-artifacts
pnpm --dir packages/core pack --pack-destination ../../release-artifacts
pnpm --dir apps/cli pack --pack-destination ../../release-artifacts
pnpm --dir apps/mcp-server pack --pack-destination ../../release-artifacts
```

`release-artifacts` is ignored by Git. Preserve candidate tarballs and SHA-256 hashes as release
evidence, but do not commit them.

Inspect every candidate:

```bash
tar -tzf release-artifacts/<package>.tgz
tar -xOf release-artifacts/<package>.tgz package/package.json
```

Reject candidates containing:

- Tests, fixtures, screenshots, browser profiles, traces, or source maps.
- `.smart-ui` stores, target source, user paths, tokens, logs, or generated reports.
- Git, file, link, workspace, HTTP tarball, or private-registry references in packed production
  dependencies.
- Missing README, declarations, entry point, or CLI shebang.
- A version, repository URL, or dependency version different from the reviewed release.

`workspace:*` is allowed in the source workspace only when the packed manifest contains the exact
released registry version.

## Clean-consumer smoke test

Install all three tarballs in a new temporary directory outside both repositories. Do not reuse the
workspace `node_modules` tree.

Prove that:

- `import('@smart-ui/core')` loads.
- `smart-ui --version` and `smart-ui --help` run.
- `smart-ui setup --target <fixture> --agent-memory --json` succeeds from the packed CLI.
- `smart-ui-mcp` completes an MCP initialize and tool-list handshake.
- `smart-ui doctor` returns structured diagnostics after launching a canary browser.
- Agent Memory opens, persists, reopens, reads, and deletes a disposable SQLite canary.
- The pinned Chromium executable launches from the documented browser location.
- No Git client or private-repository credential is needed.

Run this on Windows x64, Windows ARM64 when supported, macOS, and Linux. The desktop project cannot
start until Windows x64 passes using the same runtime assembly approach planned for the installer.

## First publication

The initial sequence is:

1. Complete the public-source audit and make the source repository public.
2. Publish Agent Memory and verify an independent registry install.
3. Replace the Git dependency and pass every Smart UI gate.
4. Produce and hash Smart UI candidate tarballs.
5. Publish `@smart-ui/core` and verify a registry install.
6. Publish `@smart-ui/cli`.
7. Publish `@smart-ui/mcp-server`.
8. Verify CLI, MCP, memory, and Chromium behavior from registry packages.
9. Create the GitHub release for the exact tag with checksums and SBOM evidence.

Scoped packages must be made public on their first publication:

```bash
npm publish release-artifacts/<core-tarball>.tgz --access public --otp <code>
npm publish release-artifacts/<cli-tarball>.tgz --access public --otp <code>
npm publish release-artifacts/<mcp-tarball>.tgz --access public --otp <code>
```

Run these commands only after checking `npm whoami`, registry, scope, version, tarball name, and
hash. npm also supports staged publication followed by 2FA approval; prefer it when available so the
artifacts can be reviewed before becoming public.

## Trusted publishing

After the first package pages exist, configure a trusted publisher for each package:

```text
Provider: GitHub Actions
Owner: Ayush-joshi
Repository: smart-ui-validator
Workflow: npm-publish.yml
Environment: npm-production
Allowed action: npm stage publish (preferred) or npm publish
```

The workflow must use a GitHub-hosted runner with `id-token: write`. Protect `npm-production` with
release-owner approval. After trusted publishing works, require 2FA, disallow traditional publish
tokens, and revoke obsolete automation tokens.

npm automatically generates provenance for public packages published from a public repository by a
trusted publisher. Keep `repository.url` exactly aligned with GitHub.

Do not add the live publish workflow until the scope and license are final, Agent Memory is consumed
from npm, clean-consumer tests pass, and the GitHub environment and npm trusted-publisher records
exist.

## Post-publication verification

```bash
npm view <package>@X.Y.Z name version repository dist.integrity dist.tarball
npm install <package>@X.Y.Z
```

Confirm the npm page is public, README and source repository are correct, integrity matches the
reviewed release, provenance is present once enabled, and binaries work on Windows and Unix-like
systems. The future desktop app consumes exact versions during its build and does not invoke `npx`
on user machines.

## Failure and rollback

Do not overwrite or republish the same version. If a release is defective:

1. Stop desktop promotion.
2. Deprecate the npm version with a precise message when appropriate.
3. Fix forward with a patch release.
4. Pin desktop builds to the last verified release.
5. Preserve the tag, tarball hashes, audit evidence, and incident record.

Use unpublish only when npm policy permits and a security or legal need outweighs dependency
breakage.

## EXE handoff gate

Work on `smart-ui-validator-exe` begins only after this chain succeeds:

```text
published Agent Memory
  -> published @smart-ui/core
  -> published @smart-ui/cli
  -> published @smart-ui/mcp-server
  -> clean Windows MCP, memory, and Chromium smoke test
```

The EXE repository consumes exact npm versions. It must not clone source repositories or resolve
`latest` during a production build.

## References

- [npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
