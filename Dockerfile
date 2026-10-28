FROM rust:1.98-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --locked --release -p opengpu-control-plane
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/apps /app/apps
COPY --from=build /src/db /app/db
COPY --from=build /src/docs /app/docs
COPY --from=build /src/media /app/media
COPY --from=build /src/supabase /app/supabase
COPY --from=build /src/Cargo.toml /app/Cargo.toml
COPY --from=build /src/target/release/opengpu-control-plane /app/bin/opengpu-control-plane
CMD ["./bin/opengpu-control-plane"]
