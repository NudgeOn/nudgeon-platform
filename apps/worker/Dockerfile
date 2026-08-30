# onda-worker + onda-migrate + 운영 CLI (Go distroless)
# 빌드 컨텍스트: 저장소 루트 (go.work·packages 접근 필요)
FROM golang:1.25 AS build
WORKDIR /src
# go.work 기반 — worker와 libqueue-go 모듈 함께
COPY go.work ./
COPY apps/worker/go.mod apps/worker/go.sum ./apps/worker/
COPY packages/libqueue-go/go.mod packages/libqueue-go/go.sum ./packages/libqueue-go/
RUN cd apps/worker && go mod download
COPY apps/worker ./apps/worker
COPY packages/libqueue-go ./packages/libqueue-go
RUN cd apps/worker && CGO_ENABLED=0 go build -o /out/onda-worker ./cmd/worker \
 && CGO_ENABLED=0 go build -o /out/onda-migrate ./cmd/migrate \
 && CGO_ENABLED=0 go build -o /out/onda-seed ./cmd/seed

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/onda-worker /onda-worker
COPY --from=build /out/onda-migrate /onda-migrate
COPY --from=build /out/onda-seed /onda-seed
# 마이그레이터가 참조할 SQL (migrator는 /db 인자로 실행)
COPY db /db
USER nonroot:nonroot
ENTRYPOINT ["/onda-worker"]
