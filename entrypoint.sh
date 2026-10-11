#!/bin/sh
# One image, two roles. Set SERVICE=mock to run the fake upstream instead of the gateway.
if [ "$SERVICE" = "mock" ]; then
  exec node mock-upstream/server.js
else
  exec node src/server.js
fi
