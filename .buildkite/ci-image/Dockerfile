# YUK-917 Buildkite Green Bridge - custom CI image for the linux-large queue.
#
# Base: the immutable amd64 manifest digest of
# mcr.microsoft.com/playwright:v1.62.1-noble, resolved 2026-08-25 with
# `docker buildx imagetools inspect` and recorded as CI_IMAGE_BASE_DIGEST in
# ../pins.env. The tag matches the repo's @playwright/test 1.62.1 pin, and the
# base ships Chromium plus every Playwright OS dependency - the Build #1
# hosted image failed all 13 usability scenarios on a missing libnspr4.so,
# which this base prevents by construction (and the assertion layer below
# fails the image build if the Chromium binary ever stops loading).
#
# Toolchain mirrors ../pins.env: Node 24.0.0 (exact nodejs.org tarball,
# checksum-verified), pnpm 11.13.1, Bun 1.3.14. git is required for the
# Buildkite checkout; jq eases manifest inspection on the agent.
#
# Built and pushed only by ../../.github/workflows/buildkite-ci-image.yml.
# Until the lead records the pushed digest in ../pins.env, the runner lane
# stays in image_digest_pending_publication and cutover stays blocked.

FROM mcr.microsoft.com/playwright@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac

ARG NODE_VERSION=24.0.0
# SHA256 from https://nodejs.org/dist/v24.0.0/SHASUMS256.txt (linux-x64 tar.gz).
ARG NODE_SHA256=b760ed6de40c35a25eb011b3cf5943d35d7a76f0c8c331d5a801e10925826cb3
ARG PNPM_VERSION=11.13.1
ARG BUN_VERSION=1.3.14

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq \
 && rm -rf /var/lib/apt/lists/*

# Exact Node release extracted over /usr/local so it wins PATH regardless of
# what the base image shipped.
RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.gz" | sha256sum -c - \
 && tar -xzf "node-v${NODE_VERSION}-linux-x64.tar.gz" -C /usr/local --strip-components=1 \
 && rm "node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && node --version

RUN npm install -g "pnpm@${PNPM_VERSION}" "bun@${BUN_VERSION}" \
 && pnpm --version \
 && bun --version

# Prove the base's Chromium bundle is really executable: the dynamic loader
# fails right here (the exact libnspr4.so failure class) if the browser or its
# OS dependencies are broken, instead of failing 13 scenarios on the queue.
RUN chrome="$(find /ms-playwright -type f -name chrome -path '*chrome-linux*' | head -n 1)" \
 && test -n "$chrome" \
 && "$chrome" --version \
 && id pwuser

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

LABEL org.opencontainers.image.title="the-learning-project buildkite-ci" \
      org.opencontainers.image.description="Pinned linux-large runner image for the YUK-917 usability lane" \
      org.opencontainers.image.source="https://github.com/Yukoval-Dakia/the-learning-project"
