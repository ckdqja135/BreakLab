FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -o /out/ ./cmd/... && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/labd /out/service-a /out/service-b /bin/
COPY --from=web /web/dist /web
COPY --from=build --chown=65532:65532 /out/data /data
