FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils python3 python3-venv ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/piper && /opt/piper/bin/pip install --no-cache-dir piper-tts==1.8.0
RUN mkdir -p /opt/piper/voice \
    && curl -fL --retry 3 -o /opt/piper/voice/en_US-libritts-high.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts/high/en_US-libritts-high.onnx \
    && curl -fL --retry 3 -o /opt/piper/voice/en_US-libritts-high.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts/high/en_US-libritts-high.onnx.json \
    && echo '9127a559e11603f10b366d1a20ac7426826081dbc521de4c2420c57728d73f0f  /opt/piper/voice/en_US-libritts-high.onnx' | sha256sum -c - \
    && echo '2efdc6d7f954588b8180132cbd9b8001933fdd00932c92bc92fd0d2028a9eb3d  /opt/piper/voice/en_US-libritts-high.onnx.json' | sha256sum -c -

WORKDIR /app

COPY . .

ENV DROP_ROOT=/data/drops
ENV GLOWHUM_DROPS_DIR=/data
ENV GLOWHUM_RSI_PIPER_BIN=/opt/piper/bin/piper
ENV GLOWHUM_RSI_PIPER_MODEL=/opt/piper/voice/en_US-libritts-high.onnx
ENV GLOWHUM_RSI_PIPER_CONFIG=/opt/piper/voice/en_US-libritts-high.onnx.json
ENV PORT=80

EXPOSE 80

CMD ["node", "server.mjs"]
