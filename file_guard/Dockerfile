FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        file \
        libmagic1 \
        clamav \
        clamav-daemon \
        clamav-freshclam \
    && rm -rf /var/lib/apt/lists/*

COPY file_guard/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY file_guard/app ./app
COPY file_guard/docker-entrypoint.sh /app/docker-entrypoint.sh
COPY file_guard/clamd.conf /etc/clamav/clamd.conf
COPY file_guard/freshclam.conf /etc/clamav/freshclam.conf

RUN chmod +x /app/docker-entrypoint.sh

CMD ["/app/docker-entrypoint.sh"]
