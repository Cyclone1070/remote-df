FROM alpine:3.20

RUN apk add --no-cache bash curl xvfb mesa-dri-gallium openbox supervisor procps

WORKDIR /app

COPY server /app/server
COPY client/dist /app/client
COPY games /app/games

EXPOSE 8484 8485

HEALTHCHECK --interval=2s --timeout=3s --retries=5 CMD curl -f http://localhost:8484/api/config || exit 1

CMD ["/app/server"]
