# Contributing to Bellwire

Bellwire welcomes reproducible bug reports, focused feature proposals,
documentation improvements, and small reviewable pull requests.

## Before opening a pull request

1. Open or reference an issue for changes that affect APIs, storage, security,
   authentication, notification delivery, licensing, or product behavior.
2. Keep the official hosted service and fully self-hosted path working. Do not
   hard-code Bellwire Cloud credentials or identifiers into reusable code.
3. Do not include private product plans, production data, screenshots containing
   user information, or credentials.
4. Preserve backward compatibility unless the issue explicitly approves a
   breaking change and migration path.

## Local checks

Use Node.js 22 or newer, then run:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run migrations:check
npm run build
npm run ios:test:unit
npm run ios:build
```

Changes to self-hosting must also keep these commands working:

```bash
npm run self-host:bootstrap -- --help
npm run self-host:doctor -- --help
npm run self-host:apns-preflight -- --help
```

## Commit sign-off

This project uses the Developer Certificate of Origin 1.1. Sign every commit
with:

```bash
git commit -s
```

The `Signed-off-by` line certifies the contribution under the
[Developer Certificate of Origin](https://developercertificate.org/). Do not
sign off on code you do not have the right to contribute. Pull requests run an
automated DCO check; bot-authored dependency updates are exempt.

## Contribution licensing

Bellwire is a multi-license repository. By contributing, you agree that your
contribution is licensed under the license assigned to the component and path
in [LICENSE.md](LICENSE.md):

- `AGPL-3.0-only` for the Workers, D1 schemas, operational tooling, and their
  JavaScript/TypeScript tests;
- `MPL-2.0` for the native iOS app and its Swift checks;
- `Apache-2.0` for the Agent Skill, CLI, protocol references, examples, and
  public documentation.

Do not move or copy code across these license boundaries without calling it
out in the pull request. Maintainers may ask for a separate change or explicit
permission when a cross-component move would change the applicable license.

Contributions do not grant rights to use Bellwire trademarks. See
[TRADEMARK.md](TRADEMARK.md).
