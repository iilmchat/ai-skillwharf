FROM python:3.12-slim

ENV DATA_DIR=/data \
    PORT=5002 \
    PYTHONUNBUFFERED=1

# WB MCP Server: 197 инструментов Seller API, транспорт SSE.
RUN pip install --no-cache-dir wb-mcp-server==2.6.1

VOLUME /data
EXPOSE 5002

CMD ["wb-mcp-web"]
