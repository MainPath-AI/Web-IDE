FROM golang:1.26-bookworm AS net
RUN git clone --depth 1 --branch v0.8.4 https://github.com/container2wasm/container2wasm.git /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -o /c2w-net ./cmd/c2w-net

FROM nginx:1.27-alpine
COPY --from=net /c2w-net /usr/local/bin/c2w-net
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx/entrypoint.sh /entrypoint.sh
COPY web/index.html web/style.css web/boot.js /usr/share/nginx/html/
COPY dist/htdocs/ /usr/share/nginx/html/
RUN chmod 755 /entrypoint.sh
EXPOSE 80 18080
ENTRYPOINT ["/entrypoint.sh"]
