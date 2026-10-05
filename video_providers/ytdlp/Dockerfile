# The immutable upstream Deno flavor includes its locked and pre-cached server
# dependencies. Its Node build stage is absent from this runtime image.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.1-deno@sha256:6e17b6fac7f91dbf59dffbdc7ee5da8988c6b2c76001b8653a5b967e8b99f389
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
       libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/acquisition \
    && mkdir -p /adapter /work \
    && chown 10001:10001 /work
COPY requirements.txt /adapter/
COPY patch_provider.py /adapter/
RUN /opt/acquisition/bin/python -m pip install --no-cache-dir --only-binary=:all: \
      --require-hashes -r /adapter/requirements.txt \
    && test ! -e /usr/bin/node \
    && test ! -e /usr/local/bin/node \
    && test ! -e /usr/bin/ffmpeg \
    && /opt/acquisition/bin/python /adapter/patch_provider.py /app/src/session_manager.ts \
    && /usr/bin/deno cache --frozen --no-check /app/src/main.ts
ENV PATH=/opt/acquisition/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DENO_DIR=/app/.cache/deno DENO_NO_PROMPT=1 DENO_NO_UPDATE_CHECK=1 \
    ACQUISITION_TEMP_ROOT=/work ACQUISITION_CONCURRENCY=10 \
    ACQUISITION_REQUESTS_PER_SECOND=2
WORKDIR /adapter
COPY service.py acquirer.py extract.py diagnostics.py proxy_sessions.py bootstrap.py source_policy.py \
     acquisition_context.py acquisition_limits.py acquisition_metadata.py acquisition_scratch.py /adapter/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).close()"
ENTRYPOINT ["python", "/adapter/bootstrap.py"]
