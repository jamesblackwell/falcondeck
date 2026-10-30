#!/bin/sh
# Explicit opt-in; the worker adapter never starts Docker automatically.
set -eu
if [ "$#" -ne 0 ]; then
  echo 'usage: falcondeck-start-test-docker' >&2
  exit 2
fi
socket=/run/falcondeck-docker/docker.sock
if docker --host "unix://$socket" info >/dev/null 2>&1; then
  exit 0
fi
sudo -n install -d -m 0750 -o root -g falcondeck-docker /run/falcondeck-docker
# An empty environment keeps model/provider credentials out of the engine.
# The engine has one Unix socket and no TCP listener. vfs avoids nested-overlay
# assumptions. Both engine cache and service volumes disappear with this session.
sudo -n sh -c 'umask 027; exec setsid env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin dockerd --host=unix:///run/falcondeck-docker/docker.sock --group=falcondeck-docker --data-root=/run/falcondeck-docker/data --exec-root=/run/falcondeck-docker/exec --pidfile=/run/falcondeck-docker/dockerd.pid --storage-driver=vfs > /run/falcondeck-docker/dockerd.log 2>&1 < /dev/null' &
for attempt in $(seq 1 60); do
  if docker --host "unix://$socket" info >/dev/null 2>&1; then
    echo "Docker ready. Use DOCKER_HOST=unix://$socket for test commands."
    exit 0
  fi
  sleep 1
done
echo 'Docker did not become ready; inspect /run/falcondeck-docker/dockerd.log inside this sandbox.' >&2
exit 1
