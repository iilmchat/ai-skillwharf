FROM python:3.12-slim

ENV DATA_DIR=/data \
    PORT=5001 \
    PYTHONUNBUFFERED=1

# Ozon MCP Server: 156 инструментов Seller API + Performance API, транспорт SSE.
RUN pip install --no-cache-dir ozon-mcp-server==2.5.2

VOLUME /data
EXPOSE 5001

CMD ["ozon-mcp-web"]
