# Offline, worker-only QA image. This is not a production multi-CLI release.
FROM nudgeon-worker:latest AS certificates
FROM scratch
ARG BUILD_REVISION
ARG BUILD_SOURCE_SHA256
LABEL org.opencontainers.image.revision=$BUILD_REVISION
LABEL io.nudgeon.worker.source-sha256=$BUILD_SOURCE_SHA256
LABEL io.nudgeon.scope="local-operations-qa-worker-only"
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY nudgeon-worker /nudgeon-worker
COPY licenses /licenses/nudgeon
USER 65532:65532
ENTRYPOINT ["/nudgeon-worker"]
