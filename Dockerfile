FROM public.ecr.aws/docker/library/node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium && \
    rm -rf /var/lib/apt/lists/*

COPY src/akmi/ src/akmi/

ENV CHROME_PATH=/usr/bin/chromium

CMD ["node", "src/akmi/loop.ts", "--headless", "--iterations=10"]
