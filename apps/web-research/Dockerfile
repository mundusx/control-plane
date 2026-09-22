FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes && cd /opt/hermes && git checkout 2c65d5aee60d0a4e2eadc34c319ca3daac203667 && uv sync --frozen --no-dev --extra firecrawl
ENV PATH="/opt/hermes/.venv/bin:$PATH" PYTHONPATH=/opt/hermes PYTHONUNBUFFERED=1
RUN uv pip install --python /opt/hermes/.venv/bin/python ddgs==9.16.0 redis==8.1.0 fastembed==0.8.0
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/models', threads=1)"
WORKDIR /app
COPY server.py research.py public_read.py evidence.py cache.py ./
CMD ["python", "server.py"]
