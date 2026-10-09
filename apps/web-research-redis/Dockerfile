FROM redis:8.2.10-alpine@sha256:b51665e66f00759be7c3152ad5ac3c66fb2f619c13ef62dea7cc1f9914524635
COPY start.sh /usr/local/bin/start-cache
RUN chmod +x /usr/local/bin/start-cache
CMD ["sh", "/usr/local/bin/start-cache"]
