# Publishing Smart UI Validator to npm

## Status

This is the release runbook for the host-neutral engine, CLI, and stdio MCP server. The first public
release completed on 2026-08-09 from source tag `v0.4.1`.

Current release status:

- Feature release `0.5.1` was prepared and fully verified on 2026-08-20. It adds persistent
  generation and existing-UI implementation handoff tasks across CLI, MCP, and Studio; immutable
  deterministic review attempts; explicit accept/cancel lifecycle commands; and the shared Generate
  UI/Validate UI Studio workflow. Registry publication was completed on 2026-08-20.
- The Smart UI repository and Agent Memory package are public.
- The previous clean-consumer advisory blocker was resolved by `dev-agent-memory@0.4.1`.
- `smart-ui-validator-core`, `smart-ui-validator`, and `smart-ui-validator-mcp` are public at
  `0.5.1`, and each `latest` tag resolves to `0.5.1`.
- Public metadata, a clean registry installation, Chromium launch, and Agent Memory persistence were
  verified on macOS. Existing-project and Windows verification remain scheduled.
- Repository metadata and provenance-based trusted publishing remain deferred until the source has
  a stable long-term owner.

Run `pnpm publish:check` before every future release candidate.

## Public packages

| Package                   | Source            | Purpose                                     | Depends on                                       |
| ------------------------- | ----------------- | ------------------------------------------- | ------------------------------------------------ |
| `smart-ui-validator-core` | `packages/core`   | Host-neutral engine and provider contracts  | Published Agent Memory package, Playwright, Zod  |
| `smart-ui-validator`      | `apps/cli`        | Primary package and `smart-ui` command      | Compatible `smart-ui-validator-core` release     |
| `smart-ui-validator-mcp`  | `apps/mcp-server` | `smart-ui-mcp` stdio command and server API | Compatible core release and the official MCP SDK |

The workspace root stays `private: true`. Fixtures, tests, evaluation inputs, repository scripts,
and the root package must never be published. All three packages use one version so a CLI or MCP
schema cannot silently target an incompatible core.

## Agent Memory handoff — completed

The reviewed public dependency is:

```text
Package name:  dev-agent-memory
Version:       0.4.1
npm URL:       https://www.npmjs.com/package/dev-agent-memory
Integrity:     sha512-zCsywPV6fFWa8riWxbjQ0sAgff7vL1nulSpUjHcTeLjMlHEe/kA4Ra88ssmNLxgJq057l5Wrl5bPIFUw6AIdhw==
Node engine:   >=22.16.0
License:       MIT
```

Smart UI initially pins the exact reviewed version:

```json
{
  "dependencies": {
    "dev-agent-memory": "0.4.1"
  }
}
```

The clean-install compatibility test must confirm that `VectorStore`, `TdaiCore`,
`StandaloneHostAdapter`, and `parseConfig` remain public. After the first compatible release is
proven, a patch-compatible range may be considered. Do not use `latest`, a Git branch or commit,
HTTP tarball, `file:`, or `link:` in a published production manifest.

`latest` is a mutable registry tag, not an immutable dependency version. Although it currently
resolves to the reviewed `dev-agent-memory@0.4.1` release, a future tag move would silently change
new installations without changing Smart UI's version. Keep the exact reviewed pin, rerun the gates,
and release a new Smart UI version whenever the Agent Memory pin changes.

## Package-name decision — completed

The public packages use unscoped product names. All three were published on 2026-08-09:

- `smart-ui-validator-core@0.4.1`
- `smart-ui-validator@0.4.1`
- `smart-ui-validator-mcp@0.4.1`

Patch release `0.4.2` was published for all three packages on 2026-08-10.
Feature release `0.5.1` was published for all three packages on 2026-08-20.

## License decision — completed

Smart UI Validator uses the standard MIT license with copyright attributed to project contributors:

- Root `LICENSE` contains the full MIT terms.
- Every public package declares SPDX `MIT`.
- Third-party notices and the SBOM remain separate release evidence.

## Public-source checklist

Before changing the Smart UI GitHub repository to public:

- Review tracked and untracked files and the relevant Git history.
- Run `pnpm privacy:check`. Set `SMART_UI_FORBIDDEN_IDENTIFIERS` to a comma-separated list of names,
  usernames, or other identifiers that must not appear in the public tree.
- Run the secret scanner and rotate credentials that may have existed while the repository was
  private.
- Review screenshots, fixtures, designs, logs, reports, and SBOMs for customer or personal data.
- Confirm contributor and upstream license obligations.
- Add a private security-reporting path.
- Enable branch protection and required checks on `main`.
- Confirm Actions do not upload private source or credentials to third parties.

Making a repository public and publishing an npm package are separate, separately reviewed actions.
The privacy check covers the current source tree; it does not rewrite Git author metadata or change
the owner displayed by the Git hosting service. Use a neutral organization and conduct a separately
approved history-rewrite review if those identity surfaces must also be removed.

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
pnpm --filter smart-ui-validator-core exec playwright install chromium
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm evaluate
pnpm evaluate:svg
pnpm security:secrets
pnpm privacy:check
pnpm package:check
pnpm consumer:check
pnpm publish:check
pnpm audit --prod --audit-level high
pnpm sbom
```

The CLI tarball must contain `dist/studio/server.js`, `dist/studio/public/index.html`, and hashed
JavaScript/CSS assets, with no source maps, sources, fixtures, or development server. Studio remains
a private workspace build input and must not appear as a fourth publishable package. The clean
consumer gate initializes a disposable dedicated workspace and runs packaged `smart-ui studio
--health-check` to prove the copied server/static assets and exact core version are usable without
workspace symlinks.

Browser E2E tests and the Agent Memory persistence canary remain required even though npm consumers
normally enter through the CLI or MCP adapter.

## Consumer dependency behavior

The published packages intentionally do not download Chromium from an npm `postinstall` script.
`npm install` installs the JavaScript packages and Agent Memory's supported native dependency, but
browser provisioning is an explicit supported step:

```bash
npm install --save-dev smart-ui-validator@X.Y.Z
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
- A version, package name, homepage, or dependency version different from the reviewed release.

`workspace:*` is allowed in the source workspace only when the packed manifest contains the exact
released registry version.

## Clean-consumer smoke test

Install all three tarballs in a new temporary directory outside both repositories. Do not reuse the
workspace `node_modules` tree.

Prove that:

- `import('smart-ui-validator-core')` loads.
- `smart-ui --version` and `smart-ui --help` run.
- `smart-ui setup --target <fixture> --agent-memory --json` succeeds from the packed CLI.
- `smart-ui-mcp` completes an MCP initialize and tool-list handshake.
- `smart-ui doctor` returns structured diagnostics after launching a canary browser.
- Agent Memory opens, persists, reopens, reads, and deletes a disposable SQLite canary.
- The pinned Chromium executable launches from the documented browser location.
- No Git client or private-repository credential is needed.

Run this on Windows x64, Windows ARM64 when supported, macOS, and Linux. The desktop project cannot
start until Windows x64 passes using the same runtime assembly approach planned for the installer.

## First npm publication — completed

The completed publication sequence was:

1. Complete the public-source audit and make the source repository public.
2. Publish Agent Memory and verify an independent registry install.
3. Replace the Git dependency and pass every Smart UI gate.
4. Produce and hash Smart UI candidate tarballs.
5. Publish `smart-ui-validator-core` and verify a registry install.
6. Publish `smart-ui-validator`.
7. Publish `smart-ui-validator-mcp`.

Remaining release follow-up:

1. Verify the published CLI and MCP against the existing `bdoom` project.
2. Complete clean Windows x64 CLI, MCP, memory, and Chromium verification.
3. Create the GitHub release for the exact tag with checksums and SBOM evidence when the release
   owner is ready.

Publish the reviewed unscoped tarballs in dependency order:

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
Owner: <neutral-github-owner>
Repository: smart-ui-validator
Workflow: npm-publish.yml
Environment: npm-production
Allowed action: npm stage publish (preferred) or npm publish
```

The workflow must use a GitHub-hosted runner with `id-token: write`. Protect `npm-production` with
release-owner approval. After trusted publishing works, require 2FA, disallow traditional publish
tokens, and revoke obsolete automation tokens.

npm automatically generates provenance for public packages published from a public repository by a
trusted publisher. Add `repository` metadata only after the repository has a stable neutral owner,
and keep its URL exactly aligned with GitHub.

Do not add the live publish workflow until the scope and license are final, Agent Memory is consumed
from npm, clean-consumer tests pass, and the GitHub environment and npm trusted-publisher records
exist.

## 0.5.1 release-candidate evidence

The 2026-08-20 candidate passed the frozen workspace install check, formatting, lint, typecheck,
production build, 189 unit/integration tests, 27 focused Studio tests, 7 real-browser end-to-end
tests, the 30-tool stdio MCP handshake, both evaluation gates, 238-file secret and privacy scans,
package inspection, clean-consumer installation and Studio health checks, the production advisory
audit, publish readiness, and SBOM generation. npm publication is pending an authenticated publisher
session.

| Package                   | Candidate SHA-256                                                  |
| ------------------------- | ------------------------------------------------------------------ |
| `smart-ui-validator-core` | `9d7693d0b87d4dc23407d93fe5a7959ff9afa2d6d1399d40965344bc7be642e7` |
| `smart-ui-validator`      | `249a2f359c6534abd9d1eff0645e621adba5dbb91cedadf7eaaa004e9aa79c06` |
| `smart-ui-validator-mcp`  | `f12a8bae43aaa903ab3dcbe9667f6907115f26297a80c1fa09bd494e12665bbd` |

CycloneDX 1.5 SBOM: 774 components,
`sha256:450503fc90a227026bb1c1706f88f2f1322def589c5c79980e3b79f0c2fb1d84`.

## Published 0.4.1 evidence

| Package                   | npm integrity                                                                                     | Candidate SHA-256                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `smart-ui-validator-core` | `sha512-JkBwHgZAQZoeO4z//y54ESqER90L6eyHhrqziDiPufmCIN9xrNy4FCaB/TAeU8obBhQhMdOOkMDCmZFxB9gntA==` | `51c6455c53e8021ce60c791c05ddfc394d6fa5752d36ab40e1720ddb9ebe87fa` |
| `smart-ui-validator`      | `sha512-GrOtUfCgx6Vq+ZpiRL/SX7vWXGgjwajdjcDq76h0YiLhP+2iXKoFE5+2WpovXehhEoOTzuK0x4fpg36G5rR/Tg==` | `4d235694aaf30f62016c752640fff6950af593d046a22f8d2610497d7c1656c6` |
| `smart-ui-validator-mcp`  | `sha512-hmGuybI0VPvo/AxAGknmhXrwK52wmZQJ4+xyaf6tsM7XcrSENw58lNPR1K/3Ft0knveLah5H/y3fZap4OY83mQ==` | `8ad13a65d97f75d7f8a6fc3eb19a39dbe368dfc46bdedb4252136422515d9ffd` |

Source commit: `120b22c060cc94bc3d4d5ae1aeb8863715fdad6a`; tag: `v0.4.1`.

## Published 0.4.2 evidence

The 2026-08-10 candidate passed the frozen install, pinned Chromium check, formatting, lint,
typecheck, build, 92 unit/integration tests, 3 real-browser end-to-end tests, evaluation, secret and
privacy scans, package inspection, clean-consumer installation, production audit, publish-readiness
check, and SBOM generation. A second clean consumer installed all three packages from the public
registry, loaded the new core and MCP exports, reported CLI version `0.4.2`, deduplicated both
adapters onto core `0.4.2`, and found no vulnerabilities.

| Package                   | npm integrity                                                                                     | Candidate SHA-256                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `smart-ui-validator-core` | `sha512-USKwrQR4hIQATGFGT7+NzVkdPWExa4CJrDDP6t4mGV34cF3/NkyXW0Pl3u2wooc2YiXJOmWmxbfxpYRgyqTuRQ==` | `de63ea1917bc0958d13661c7738c31d560b24c2bb50c6385ab6180d35e54c8f8` |
| `smart-ui-validator`      | `sha512-dXMERorrz/owSlJ8o8kvp63sI9F/Isg0mg2Ninncu7RdsbRO0+SR8d95Jo7yyU6INqiQAA4nq6/uSyfnLMblYQ==` | `2d68e234cb61bba6435d89deb77fc628791c239cbb89722cefab9ec40a08c317` |
| `smart-ui-validator-mcp`  | `sha512-beIXWiu8wk5hgZChRKzqGB+d/hNIRnQqoiOyIKcIu+Wt9u/GhZ13ajpVIKp/Qbcbb/0f09VhUTmnNYkHFnDFuA==` | `10b58af2e3297970cae3f058dc8e8420bc6817cfd9403a836696616697f6044a` |

CycloneDX 1.5 SBOM: 797 components,
`sha256:2975f9c544f8df75840940fe9aba415d6b2cf166fd5f25d3dc36904c4ad37a2d`.

Source commit: `6611a5ebbf207062d75dd316adde6b09bb5b0c17`; tag: `v0.4.2`. Both `main` and
the annotated tag were verified on GitHub before npm publication.

## Post-publication verification

```bash
npm view <package>@0.4.2 name version license homepage dist.integrity dist.tarball
npm install <package>@0.4.2
```

Confirm the npm page is public, its README/license/homepage are correct, integrity matches the
reviewed release, provenance is present once a neutral public repository is configured, and binaries
work on Windows and Unix-like systems. The future desktop app consumes exact versions during its
build and does not invoke `npx` on user machines.

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
  -> published smart-ui-validator-core
  -> published smart-ui-validator
  -> published smart-ui-validator-mcp
  -> clean Windows MCP, memory, and Chromium smoke test
```

The EXE repository consumes exact npm versions. It must not clone source repositories or resolve
`latest` during a production build.

## References

- [npm package publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
