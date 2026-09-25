# Stage 1: Build libdatachannel and libdf_streamer.so
FROM ubuntu:24.04 AS interposer-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    g++ \
    make \
    cmake \
    git \
    libssl-dev \
    libzstd-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch v0.22.2 --recursive https://github.com/paullouisageneau/libdatachannel.git /tmp/ldc \
    && cmake -B /tmp/ldc/build -S /tmp/ldc \
        -DBUILD_SHARED_LIBS=ON \
        -DNO_MEDIA=ON \
        -DNO_WEBSOCKET=ON \
        -DUSE_GNUTLS=OFF \
        -DUSE_MBEDTLS=OFF \
        -DNO_EXAMPLES=ON \
        -DNO_TESTS=ON \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
    && cmake --build /tmp/ldc/build -j$(nproc) \
    && cmake --install /tmp/ldc/build \
    && rm -rf /tmp/ldc

WORKDIR /build
COPY interposer/ /build/
RUN make clean && make -j$(nproc)

# Stage 2: Build React frontend
FROM node:22-alpine AS frontend-builder

WORKDIR /frontend
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 3: Build Go Hub Server
FROM golang:1.24-alpine AS server-builder

WORKDIR /build
COPY server/go.mod server/go.sum ./
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/server main.go

# Stage 4: Minimal runtime image
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libsdl2-2.0-0 \
    libsdl2-image-2.0-0 \
    libzstd1 \
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy libdatachannel shared library
COPY --from=interposer-builder /usr/local/lib/libdatachannel.so* /usr/local/lib/
RUN ldconfig

# Copy built interposer hook
COPY --from=interposer-builder /build/libdf_streamer.so /app/libdf_streamer.so

# Copy built React client assets
COPY --from=frontend-builder /frontend/dist /app/client

# Copy built Go Hub server
COPY --from=server-builder /bin/server /app/server
RUN chmod +x /app/server

# Copy default game manifests
COPY games/ /app/games/

ENV PORT=8484
EXPOSE 8484/tcp 8484/udp

VOLUME ["/game"]

HEALTHCHECK --interval=2s --timeout=3s --retries=5 CMD curl -f http://localhost:8484/api/config || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/server"]
