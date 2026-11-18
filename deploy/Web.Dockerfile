FROM node:22-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /src
COPY coupon-client ./coupon-client
RUN cd coupon-client && pnpm install --frozen-lockfile && pnpm build
COPY frontend ./frontend
RUN cd frontend && pnpm install --frozen-lockfile && VITE_COUPON_LOGIN=true pnpm build

FROM nginx:1.28-alpine
COPY --from=build /src/frontend/dist /usr/share/nginx/html
COPY deploy/shop.conf /etc/nginx/conf.d/default.conf
