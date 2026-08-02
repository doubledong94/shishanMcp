#!/bin/sh
# Entry point: start nginx (web page) + the MCP backend in one container.
nginx
exec node backend/dist/main-http.js
