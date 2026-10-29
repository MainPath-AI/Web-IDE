# amd64 guest that QEMU-Wasm boots in the browser.
# Built with: docker build --platform linux/amd64 -t web-ide-guest:local guest

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    ASDF_DIR=/root/.asdf \
    ASDF_DATA_DIR=/root/.asdf \
    PATH=/root/.asdf/shims:/root/.asdf/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        tar \
        xz-utils \
        iptables \
        procps \
    && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=20.19.5
ARG HUGO_VERSION=0.168.0
ARG PYTHON_VERSION=3.12.7
ARG PYTHON_STAMP=20241016
ARG ASDF_VERSION=v0.14.1
ARG CODE_SERVER_VERSION=4.143.1
ARG DOCKER_VERSION=27.5.1

RUN git clone --depth 1 --branch "${ASDF_VERSION}" https://github.com/asdf-vm/asdf.git /root/.asdf \
    && . /root/.asdf/asdf.sh \
    && asdf plugin add python \
    && asdf plugin add nodejs \
    && asdf plugin add hugo

RUN mkdir -p /tmp/dl /root/.asdf/installs/python/3.12.7 /root/.asdf/installs/nodejs/20.19.5 /root/.asdf/installs/hugo/0.168.0/bin \
    && curl -fsSL -o /tmp/dl/python.tgz \
        "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STAMP}/cpython-${PYTHON_VERSION}%2B${PYTHON_STAMP}-x86_64-unknown-linux-gnu-install_only.tar.gz" \
    && tar -xzf /tmp/dl/python.tgz -C /tmp/dl \
    && cp -a /tmp/dl/python/. /root/.asdf/installs/python/3.12.7/ \
    && ln -sf python3 /root/.asdf/installs/python/3.12.7/bin/python \
    && ln -sf pip3 /root/.asdf/installs/python/3.12.7/bin/pip \
    && curl -fsSL -o /tmp/dl/node.tar.xz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && tar -xJf /tmp/dl/node.tar.xz -C /tmp/dl \
    && cp -a "/tmp/dl/node-v${NODE_VERSION}-linux-x64/." /root/.asdf/installs/nodejs/20.19.5/ \
    && curl -fsSL -o /tmp/dl/hugo.tgz \
        "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-amd64.tar.gz" \
    && tar -xzf /tmp/dl/hugo.tgz -C /root/.asdf/installs/hugo/0.168.0/bin hugo \
    && printf 'python %s\nnodejs %s\nhugo %s\n' "${PYTHON_VERSION}" "${NODE_VERSION}" "${HUGO_VERSION}" > /root/.tool-versions \
    && . /root/.asdf/asdf.sh \
    && asdf reshim \
    && rm -rf /tmp/dl

RUN curl -fsSL -o /tmp/code-server.tgz \
        "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
    && mkdir -p /opt \
    && tar -xzf /tmp/code-server.tgz -C /opt \
    && ln -sf "/opt/code-server-${CODE_SERVER_VERSION}-linux-amd64/bin/code-server" /usr/local/bin/code-server \
    && rm -f /tmp/code-server.tgz

RUN curl -fsSL -o /tmp/docker.tgz \
        "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
    && tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1 \
    && rm -f /tmp/docker.tgz

COPY demos /opt/web-ide/demos
COPY web-ide-init.sh /usr/local/bin/web-ide-init
RUN chmod 755 /usr/local/bin/web-ide-init /opt/web-ide/demos/run-all.sh \
    && printf '%s\n' '. /root/.asdf/asdf.sh' 'cd /opt/web-ide/demos' > /root/.bashrc \
    && printf '%s\n' '. /root/.asdf/asdf.sh' > /root/.profile

WORKDIR /opt/web-ide/demos
ENTRYPOINT ["/usr/local/bin/web-ide-init"]
