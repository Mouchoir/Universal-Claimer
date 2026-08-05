# The whole application in one image: the web portal and the claim worker, run side by side by
# deploy/entrypoint.mjs. They were two images and two services until it became clear that a
# four-container stack (postgres + migrate + web + worker) is a lot of moving parts to hand an
# operator for a single-user deployment, and that only postgres genuinely needs its own lifecycle.
#
# Runs CloakBrowser (source-patched Chromium) HEADED under Xvfb on a headless host. x86_64 only.
FROM node:20-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN corepack pnpm install --frozen-lockfile
# Next build for the portal, tsc -b for the worker; each also builds the workspace packages it
# references, which together cover everything the entrypoint runs.
RUN corepack pnpm --filter "@uc/web..." build \
    && corepack pnpm --filter @uc/worker build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# System deps: Xvfb (virtual display) + every shared library this Chromium links against.
# The list is deliberately complete rather than minimal: an incomplete one fails only at the
# first browser launch, with "error while loading shared libraries" buried in a launch log — the
# original list was missing libcairo/libpango/GTK and every claim died on a headless host.
# The `ldd` check below turns a missing library into a build failure instead.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth ca-certificates fonts-liberation \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libgdk-pixbuf-2.0-0 libgtk-3-0 libglib2.0-0 libx11-6 libxcb1 libxext6 \
    libxi6 libxtst6 libexpat1 libdbus-1-3 libudev1 \
    && rm -rf /var/lib/apt/lists/*

# The whole built workspace (node_modules + packages' dist + the web .next build). The custom
# web server requires node_modules at runtime (next, ws, @uc/*), so Next's standalone tracing is
# not used here.
COPY --from=build /app ./

# The CloakBrowser Chromium is fetched at *runtime* into a cache directory, not baked into the
# image. Two reasons: shipping the binary in a published image would redistribute a third-party
# build whose terms are CloakHQ's to set, and it keeps the image far smaller. Mount a volume on
# CLOAKBROWSER_CACHE_DIR and the ~200MB download happens once, not on every container start.
ENV CLOAKBROWSER_CACHE_DIR=/var/lib/cloakbrowser
# Where the deployment's generated secrets live. Mount a volume here or an update regenerates the
# encryption key and every stored account session becomes unreadable (deploy/entrypoint.mjs).
ENV UC_CONFIG_DIR=/var/lib/uc
# For CloakBrowser Pro (latest Chromium), set CLOAKBROWSER_LICENSE_KEY in the environment.

# Still verify at build time that this image can actually run Chromium — the missing-library
# failure otherwise surfaces only at the first claim, buried in a launch log. The binary is
# downloaded, checked and deleted inside a single layer, so the image does not carry it.
RUN CLOAKBROWSER_CACHE_DIR=/tmp/cb-verify \
    corepack pnpm --filter @uc/connectors exec cloakbrowser install \
    && CHROME="$(find /tmp/cb-verify -name chrome -type f | head -1)" \
    && echo "checking $CHROME" \
    && ! ldd "$CHROME" | grep "not found" \
    && "$CHROME" --headless=new --no-sandbox --dump-dom about:blank > /dev/null \
    && echo "chromium launches" \
    && rm -rf /tmp/cb-verify

# Stamped by the release workflow. Left as "dev" for a local build, which is also how the update
# check tells "I am running a published release" from "I am running something someone built".
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0
ENV DISPLAY=:99
# The entrypoint is exec'd directly, so node is PID 1 and `docker stop` delivers SIGTERM to the
# supervisor rather than to a wrapper script that would swallow it. It also keeps stdout
# unbuffered and unwrapped: an earlier `xvfb-run` wrapper hid the worker's logs entirely, which
# on a headless NAS leaves the operator with nothing to diagnose.
CMD ["node", "deploy/entrypoint.mjs"]
