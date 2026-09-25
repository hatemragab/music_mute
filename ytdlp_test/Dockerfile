FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG YTDLP_VERSION=2026.09.16.232951
ARG YTDLP_SHA256=f8ca14db511702a5dbfc5a527056312907ddd0914d0b4036f108d6849e17ef61
ARG DENO_VERSION=2.9.7
ARG DENO_SHA256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip ffmpeg \
 && curl -fsSL --retry 2 "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/${YTDLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
 && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
 && chmod 755 /usr/local/bin/yt-dlp \
 && curl -fsSL --retry 2 "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o /tmp/deno.zip \
 && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
 && unzip /tmp/deno.zip -d /usr/local/bin \
 && rm /tmp/deno.zip && apt-get purge -y curl unzip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --create-home tester && mkdir /work && chown tester:tester /work
WORKDIR /app
COPY runner.py server.py extractor.py network_guard.py test_runner.py test_server.py test_network_guard.py runtime_checks.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER tester
RUN python -m unittest discover -v && yt-dlp --version && deno --version
HEALTHCHECK --interval=30s --timeout=5s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3).read()"]
EXPOSE 8080
CMD ["python", "server.py"]
