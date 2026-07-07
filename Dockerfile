FROM python:3.12-slim

WORKDIR /app

RUN useradd --shell /bin/false appuser \
    && mkdir -p /home/appuser/.aws \
    && chown -R appuser:appuser /home/appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt awscli

COPY app/ ./app/
COPY static/ ./static/

USER appuser

ENV HOME=/home/appuser \
    CONFIG_PATH=/config/config.yaml \
    AWS_CONFIG_FILE=/home/appuser/.aws/config \
    AWS_SHARED_CREDENTIALS_FILE=/home/appuser/.aws/credentials

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
