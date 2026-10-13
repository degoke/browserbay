## What this changes

<!-- What it does and why. Link the issue it closes, if there is one: "Closes #123". -->

## How it was checked

<!-- The tests you added or ran. For a bug fix, say what failed before. -->

## Checklist

- [ ] `pnpm run ci` passes (and the checks for any other part I touched: site, clients, chart).
- [ ] I added or updated tests, and a bug fix has a test that fails without it.
- [ ] I updated the docs (README and `site/src/content/docs/`) if behaviour, a setting or a limit changed.
- [ ] I added a line under **Unreleased** in `CHANGELOG.md` for anything a user would notice.
- [ ] If I changed `src/node/scope.ts`, I re-ran `pnpm test:browser` and checked a test fails when the rule is broken.
- [ ] No secret (API key, slot token, enrollment secret) is logged, returned or stored by this change.
- [ ] This is about the box itself, not an agent, model or crawling feature (see CONTRIBUTING.md).
