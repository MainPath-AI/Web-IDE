# syntax=docker/dockerfile:1.5
ARG GUEST_IMAGE=web-ide-guest:local
ARG CODE_SERVER_VERSION=4.143.1

# This is a stopped build stage, never a host-side editor service.
FROM --platform=linux/amd64 ${GUEST_IMAGE} AS editor

# scripts/build.sh overrides this stage with its newly verified package.
FROM scratch AS vm-assets
COPY dist/htdocs/ /

FROM golang:1.26-bookworm AS net
RUN git clone --depth 1 --branch v0.8.4 https://github.com/container2wasm/container2wasm.git /src \
    && test "$(git -C /src rev-parse HEAD)" = 6ed3d98882a2b22eafc1334f574c364a5b2b8c47
WORKDIR /src
COPY nginx/bridge/main.go /src/cmd/web-ide-bridge/main.go
RUN CGO_ENABLED=0 go build -o /web-ide-bridge ./cmd/web-ide-bridge

FROM nginx:1.27-alpine
ARG CODE_SERVER_VERSION
COPY --from=net /web-ide-bridge /usr/local/bin/web-ide-bridge
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/entrypoint.sh /entrypoint.sh
COPY --from=vm-assets / /usr/share/nginx/html/
COPY web/ /usr/share/nginx/html/
# Serve the exact guest's complete browser assets, including built-in
# extensions, workers, fonts and node_modules. Session APIs stay in the guest.
COPY --from=editor /opt/code-server-${CODE_SERVER_VERSION}-linux-amd64/lib/vscode /usr/share/nginx/editor/vscode
COPY --from=editor /opt/code-server-${CODE_SERVER_VERSION}-linux-amd64/out/browser /usr/share/nginx/editor/coder/out/browser
COPY --from=editor /opt/code-server-${CODE_SERVER_VERSION}-linux-amd64/src/browser /usr/share/nginx/editor/coder/src/browser
RUN chmod 755 /entrypoint.sh
EXPOSE 80 18080
ENTRYPOINT ["/entrypoint.sh"]
STOPSIGNAL SIGTERM
