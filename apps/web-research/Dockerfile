FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
RUN git clone --depth 1 --branch v0.21.6 https://github.com/NousResearch/hermes-agent.git /opt/hermes && cd /opt/hermes && test "$(git rev-parse HEAD)" = 818c13be1dc4fd28987e1e881a9408224afd4535 && uv sync --frozen --no-dev --extra firecrawl
ENV HERMES_VERSION=0.21.6 HERMES_COMMIT=818c13be1dc4fd28987e1e881a9408224afd4535
ENV PATH="/opt/hermes/.venv/bin:$PATH" PYTHONPATH=/opt/hermes PYTHONUNBUFFERED=1
RUN uv pip install --python /opt/hermes/.venv/bin/python ddgs==9.16.0 redis==8.1.0 fastembed==0.8.0
RUN python -c "import inspect; from run_agent import AIAgent; from tools.web_tools import web_search_tool, web_extract_tool; from tools.url_safety import create_ssrf_safe_client, is_safe_url; from tools.website_policy import check_website_access; from tools.web_tools_extract import _validate_extract_urls; assert hasattr(AIAgent, 'run_conversation'); assert {'run_budget_seconds', 'skip_context_files', 'skip_background_review', 'tool_complete_callback'} <= set(inspect.signature(AIAgent).parameters)"
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5', cache_dir='/opt/models', threads=1)"
WORKDIR /app
COPY server.py research.py public_read.py evidence.py cache.py ./
CMD ["python", "server.py"]
