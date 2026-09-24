FROM node:22-bookworm-slim AS node
FROM public.ecr.aws/k5j5w0x5/cua-ubuntu-24.04:docker-latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable \
    && python3 -m venv /opt/perpetual/venv \
    && /opt/perpetual/venv/bin/pip install --no-cache-dir cua-driver==0.28.2
RUN /opt/perpetual/venv/bin/python -c "from cua_driver.wrapper import get_binary_path; import os; os.symlink(get_binary_path(), '/usr/local/bin/perpetual-cua-driver')" \
    && ln -sf /usr/local/bin/perpetual-cua-driver /usr/local/bin/cua-driver \
    && groupadd --gid 1000 perpetual && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash perpetual \
    && sed -i 's|/root|/home/perpetual|g' /opt/desktop/start.sh
COPY supervisord.conf /etc/supervisor/supervisord.conf
ENV HOME=/home/perpetual USER=perpetual DISPLAY=:1 XAUTHORITY=/home/perpetual/.Xauthority
# The process supervisor starts as root and drops to the dedicated guest user.
# Application commands and the desktop run as UID 1000.
USER root
