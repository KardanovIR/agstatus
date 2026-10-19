# The build stage runs once, on the builder's own platform, whatever platforms
# the image is being built for: $BUILDPLATFORM pins it there, and every target's
# runtime stage copies from that one run. So no RUN in this file ever executes
# under emulation. Twice in the 1.6.2 release, `npm ci` died under QEMU in the
# arm64 half ("uncaught target signal 4 (Illegal instruction)") and then hung
# until the job timed out, while the amd64 half took seconds.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
# --ignore-scripts: dev-only better-sqlite3 (migration tooling) would otherwise
# try a native build here; nothing in this image needs install scripts.
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Copying one node_modules into every platform's image is only sound while the
# runtime closure is pure JavaScript, as express, express-rate-limit and pg
# are. Refuse anything that would differ by platform rather than ship this
# machine's binary to the other one: a compiled addon or its prebuilds, an
# addon left uncompiled (install scripts are off), or a package npm chose for
# this machine's os, cpu or libc.
RUN native=$(find node_modules \( -name '*.node' -o -name binding.gyp -o -name prebuilds \) -print) \
 && picked=$(node -p 'const p = require("./node_modules/.package-lock.json").packages; Object.keys(p).filter((k) => p[k].os || p[k].cpu || p[k].libc).join("\n")') \
 && if [ -n "$native$picked" ]; then \
      printf '%s\n' 'Platform-specific files in the runtime dependencies; this stage is shared by every platform:' $native $picked >&2; \
      exit 1; \
    fi

# One per target platform, and only COPY: nothing here runs, so building the
# foreign platform needs its base image and no emulator. Keep it that way. A
# RUN added here would not fail for want of an emulator: the BuildKit that
# release.yml and CI start ships its own QEMU and would run it under that for
# arm64. scripts/check-dockerfile-platforms.sh, which both run before they
# build, is what refuses a RUN outside a $BUILDPLATFORM stage.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
