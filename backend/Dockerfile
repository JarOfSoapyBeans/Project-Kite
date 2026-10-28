FROM node:22-alpine
WORKDIR /app
COPY package.json *.js ./
# Cookie jars (your logins) are saved here; mount a volume to keep them:
#   docker run -v kite-data:/data ...
RUN mkdir -p /data && chown node /data
ENV PORT=8080 COOKIE_FILE=/data/cookies.json
EXPOSE 8080
USER node
CMD ["node", "server.js"]
