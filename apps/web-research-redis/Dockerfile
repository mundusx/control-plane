FROM redis:8.2-alpine
COPY start.sh /usr/local/bin/start-cache
RUN chmod +x /usr/local/bin/start-cache
CMD ["sh", "/usr/local/bin/start-cache"]
