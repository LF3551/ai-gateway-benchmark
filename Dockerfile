FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -o /out/mock ./cmd/mock && \
    CGO_ENABLED=0 go build -trimpath -o /out/load ./cmd/load

FROM alpine:3.22@sha256:d406446bc05b82480756ce8f1287964d28768c23955fa9480d2a74a2eae7a654
COPY --from=build /out/mock /out/load /usr/local/bin/
