# Fast Embedding Service with ONNX Runtime
# ~3-5x faster than PyTorch on CPU

FROM python:3.11-slim

WORKDIR /app

# Install dependencies for ONNX Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages - ONNX optimized
RUN pip install --no-cache-dir \
    flask \
    gunicorn \
    transformers \
    optimum[onnxruntime] \
    numpy \
    requests

# Copy application
COPY app_onnx.py ./app.py

# Pre-download and convert model to ONNX at build time
ARG EMBEDDING_MODEL=intfloat/e5-small-v2
ENV EMBEDDING_MODEL=${EMBEDDING_MODEL}

RUN python -c "\
from optimum.onnxruntime import ORTModelForFeatureExtraction; \
from transformers import AutoTokenizer; \
import os; \
model_name = os.environ.get('EMBEDDING_MODEL', 'intfloat/e5-small-v2'); \
print(f'Converting {model_name} to ONNX...'); \
AutoTokenizer.from_pretrained(model_name); \
ORTModelForFeatureExtraction.from_pretrained(model_name, export=True); \
print('ONNX model ready!')"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

# Run with gunicorn for better performance
# - 4 workers for parallel requests
# - threads for handling concurrent requests within worker
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "4", "--timeout", "120", "app:app"]
