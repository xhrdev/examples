FROM public.ecr.aws/docker/library/node:26-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

RUN npx playwright install --with-deps chromium

RUN ln -s /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome /usr/local/bin/playwright-chrome

COPY src/akmi/ src/akmi/

ENV CHROME_PATH=/usr/local/bin/playwright-chrome

CMD ["node", "src/akmi/loop.ts", "--headless", "--iterations=10"]
