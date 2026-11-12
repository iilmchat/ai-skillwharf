# syntax=docker/dockerfile:1

# Образ для выполнения навыков, которым нужны внешние API:
# curl — HTTP-запросы, jq — разбор JSON, gh — GitHub CLI, bash — скрипты навыков.
FROM alpine:3.20

RUN apk add --no-cache curl jq github-cli bash python3 py3-pip
