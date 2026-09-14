#!/bin/sh
# Stands in for `dsh web`: prints the readiness line, then stays alive until
# it is signalled — exactly the lifecycle the desktop shell must supervise.
echo "dsh: booting profile web"
sleep 0.3
echo "dsh web: http://127.0.0.1:45678/?token=fake-launch-token (LAN: http://192.168.1.5:45678/?token=fake-launch-token)"
echo "dsh: ready"
while true; do sleep 1; done
