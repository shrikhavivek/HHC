FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY app ./app
COPY tests ./tests
COPY pytest.ini ./pytest.ini
RUN mkdir -p /data/outputs /data/media
RUN python -m compileall -q app && useradd --uid 10001 --user-group --no-create-home hhc && chown -R 10001:10001 /app /data
USER 10001:10001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
