# QualityOS parser sidecar (ADR-0013, T-P3-05). Untrusted documents are parsed here, so the
# container runs as an unprivileged user with a read-only root filesystem, no network at runtime
# (an internal Compose network) and memory/CPU limits set by Compose.
#
# Models are downloaded at build time and baked in (P0 finding 4: no runtime downloads).
# The image is large (torch CPU + Docling layout models + EasyOCR ar/en): budget several GB.
FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/hf QOS_OCR_MODELS=/models/easyocr HOME=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
# CPU-only torch wheels keep the image smaller than the default CUDA build.
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt

# Bake models: Docling layout/table models and EasyOCR Arabic + English.
RUN mkdir -p /models/easyocr \
 && python -c "from docling.utils.model_downloader import download_models; download_models()" \
 && python -c "import easyocr; easyocr.Reader(['ar','en'], gpu=False, model_storage_directory='/models/easyocr')" \
 && chmod -R a+rX /models

COPY qos_parser ./qos_parser
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin parser
USER parser
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=5s --retries=30 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/readyz').status==200 else 1)"
CMD ["uvicorn", "qos_parser.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
