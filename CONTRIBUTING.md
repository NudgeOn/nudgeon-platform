# Contributing to Onda

Thanks for helping improve Onda. This repository accepts code, documentation,
tests, and other project materials under the rules below.

## Inbound license

Unless you explicitly and conspicuously state otherwise before submission, every
contribution intentionally submitted for inclusion in this repository is
licensed under the Apache License 2.0, without additional terms or conditions.
This follows Section 5 of the repository's [Apache License 2.0](LICENSE).

Contributors retain copyright in their contributions. Onda does not currently
require a copyright assignment or a separate Contributor License Agreement.

Do not submit code, media, data, or other material unless you have the right to
license it on these terms. Identify third-party or generated material in the pull
request and preserve all required notices.

## Developer Certificate of Origin 1.1

Every commit must be signed off to certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). The
sign-off confirms, among other things, that you created the contribution or have
the right to submit it under the project's license and that the contribution and
certificate may be made public.

Create a signed-off commit with:

```bash
git commit -s
```

Git appends a trailer in this form:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Use a name and email you are authorized to use. Add the sign-off to every commit
in the pull request; a pull-request description or comment is not a substitute.
To add it to the latest local commit, use `git commit --amend --signoff` and
update the branch normally.

## Before opening a pull request

1. Keep each change focused and explain its user-visible or operational impact.
2. Add or update tests and public documentation where behavior changes.
3. Run the checks relevant to the changed area:

   ```bash
   pnpm build
   pnpm test
   pnpm lint
   pnpm typecheck
   go build ./...
   go test ./...
   ```

4. Confirm that no credentials, personal data, generated build output, or
   unrelated local files are included.
5. Call out new dependencies, bundled binaries, copied assets, or license
   obligations so release notices and the SBOM can be updated.

Maintainers may ask for focused tests, documentation, or licensing evidence
before accepting a contribution.
