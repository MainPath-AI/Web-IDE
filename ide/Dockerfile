FROM codercom/code-server:4.104.2

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git python3 xz-utils \
    && curl -fsSL "https://nodejs.org/dist/v20.19.5/node-v20.19.5-linux-x64.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1 \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/web-ide-code
COPY project/ /opt/web-ide-seed/
RUN chmod 755 /usr/local/bin/web-ide-code \
    && chown -R coder:coder /opt/web-ide-seed
USER coder
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/web-ide-code"]
