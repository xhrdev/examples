FROM public.ecr.aws/docker/library/node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY src/maiaki/ src/maiaki/

RUN npm ci --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && ln -s /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome /usr/local/bin/playwright-chrome

ENV CHROME_PATH=/usr/local/bin/playwright-chrome

CMD ["node", "src/maiaki/loop.ts", "--headless", "--iterations=10"]
