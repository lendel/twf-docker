# syntax=docker/dockerfile:1
# twf-docker — ton-wallet-finder ready to run as a RunPod (or any Docker) CPU pod.
# The container command is the twf command line, e.g. `find abc --wallet v5r1`.

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# tini: proper PID 1 (signal forwarding, zombie reaping); openssh-server: RunPod SSH access.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_*   # host keys are generated per container at start-up

ENV NODE_ENV=production
WORKDIR /opt/twf
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY sshd_config /etc/ssh/sshd_config.d/twf.conf
RUN chmod 755 /usr/local/bin/entrypoint.sh src/twf.js \
 && ln -s /opt/twf/src/twf.js /usr/local/bin/twf \
 && mkdir -p /results && chmod 700 /results

WORKDIR /results
EXPOSE 22
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["help"]
