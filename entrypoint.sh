#!/bin/sh
# Container entrypoint: optional sshd, then the twf command, then (on RunPod) stay alive
# so the pod is not restarted into a second, paid search and results can be fetched.
set -u

# Raw shell access: "bash", "sh" or an absolute path as the command.
case "${1:-}" in
    bash|sh|/*) exec "$@" ;;
esac

# RunPod injects the account's SSH public key as PUBLIC_KEY.
if [ -n "${PUBLIC_KEY:-}" ]; then
    mkdir -p /root/.ssh /run/sshd
    chmod 700 /root/.ssh
    printf '%s\n' "$PUBLIC_KEY" > /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    ssh-keygen -A >/dev/null 2>&1
    if /usr/sbin/sshd; then echo "[twf] sshd started on port 22 (key auth only)"; fi
fi

twf "$@"
code=$?

keep="${TWF_KEEP_ALIVE:-auto}"
if [ "$keep" = auto ]; then
    if [ -n "${RUNPOD_POD_ID:-}" ]; then keep=1; else keep=0; fi
fi

if [ "$keep" = 1 ]; then
    echo "[twf] command finished with exit code $code. The container stays up so you can read"
    echo "[twf] the results (logs / web terminal / SSH). STOP AND DELETE THE POD when done — it is billed."
    exec sleep infinity
fi
exit "$code"
