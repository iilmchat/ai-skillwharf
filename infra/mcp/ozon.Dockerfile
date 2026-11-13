FROM python:3.12-slim

ENV DATA_DIR=/data \
    PORT=5001 \
    PYTHONUNBUFFERED=1

# Ozon MCP Server: 156 инструментов Seller API + Performance API, транспорт SSE.
RUN pip install --no-cache-dir ozon-mcp-server==2.5.2

# Единый healthcheck: проверяет OZON_CLIENT_ID/OZON_API_KEY и /api/health.
COPY infra/mcp/healthcheck.py /usr/local/bin/mcp-healthcheck.py
RUN chmod +x /usr/local/bin/mcp-healthcheck.py

VOLUME /data
EXPOSE 5001

CMD ["ozon-mcp-web"]
