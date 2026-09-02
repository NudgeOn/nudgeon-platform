# Third-party notices and release boundary

> **Not a complete third-party notice file.** This document records confirmed
> high-risk boundaries in the current repository. It is not an exhaustive
> inventory, a generated SBOM, or proof that a release artifact satisfies every
> dependency license. Do not ship this file alone as the complete compliance
> package.

NudgeOn's Apache-2.0 license applies only to NudgeOn-authored material. Dependencies,
base images, operating-system packages, generated clients, copied assets, and
bundled native libraries remain under their own licenses.

## fflate 0.8.2

The console uses `fflate@0.8.2` to inspect uploaded email-template ZIP files in
the browser. The package declares the MIT license.

MIT License

Copyright (c) 2023 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## sharp and prebuilt libvips

The current `pnpm-lock.yaml` resolves Next.js's optional image dependency to
`sharp@0.35.4` and its platform packages to `@img/sharp-libvips-*@1.3.3`.

- `sharp@0.35.4` declares `Apache-2.0`.
- The installed `@img/sharp-libvips-*@1.3.3` package metadata declares
  `LGPL-3.0-or-later` for the prebuilt libvips bundle.
- The upstream [libvips project](https://github.com/libvips/libvips) identifies
  libvips itself as `LGPL-2.1-or-later`.
- Each platform bundle can contain additional native libraries. Its
  `versions.json` describes versions, but it is not by itself a complete
  license or notice set.

A release that contains a prebuilt sharp/libvips binary must inventory the exact
platform bundle and its bundled libraries, retain applicable license texts and
attributions, and review the LGPL source, modification, and relinking
requirements for that artifact. The lockfile's list of optional packages does
not prove which binary was actually copied into a container or package.

## Redis container version boundary

`deploy/compose.yaml` currently uses the mutable image tag `redis:7`. That tag
does not identify a minor version or immutable image digest, while Redis 7
crosses a license boundary:

- Redis 7.2.x and earlier: `BSD-3-Clause`.
- Redis Community Edition 7.4.x through 7.8.x: choice of `RSALv2` or `SSPLv1`.

These version boundaries come from the official
[Redis licensing overview](https://redis.io/legal/licenses/). RSALv2 and SSPLv1
are source-available licenses rather than OSI-approved open-source licenses.

Before a release, resolve and pin an exact Redis version and image digest, record
the selected license option, and include the corresponding terms and notices.
Do not describe a deployment as an all-permissive open-source bundle based only
on the `redis:7` tag. If the default is changed to Redis 8 or another
implementation such as Valkey, perform a fresh compatibility and license review
rather than carrying this entry forward.

## Required release inventory

For every source archive, npm package, Go binary, and container image that is
published:

1. Build the final artifact reproducibly enough to identify what was actually
   included.
2. Generate an SPDX or CycloneDX SBOM for that artifact, including bundled
   native and operating-system components.
3. Generate and review a license report from the resolved Node, Go, container,
   and system dependencies.
4. Carry required license texts, attribution notices, source offers or source
   locations, and modification notices in the distributed form.
5. Record the exact base-image versions and digests. The PostgreSQL, ClickHouse,
   Redis, and application images are not fully inventoried by this file.
6. Treat additions or upgrades as a new review boundary and update the released
   notice set.

Known omissions from this repository-level note include most JavaScript and Go
dependencies, container base layers, Linux distribution packages, database
images, transitive native codecs, and any dependencies introduced by build or
release tooling.
