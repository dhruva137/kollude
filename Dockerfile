FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY kollude ./kollude
COPY --from=web /src/web/dist ./web/dist
RUN pip install --no-cache-dir .
EXPOSE 8787
CMD ["kollude", "serve", "--host", "0.0.0.0", "--port", "8787"]
