# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24-bookworm-slim
FROM node:${NODE_VERSION} AS devcontainer

ARG TZ
ENV TZ="$TZ"

# System packages: squid for the egress allowlist, iptables/ipset for the
# transparent redirect, plus the usual interactive shell tooling. Kept
# minimal — no oh-my-zsh chrome, no language toolchains beyond Node.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dumb-init \
        git \
        gnupg \
        iproute2 \
        ipset \
        iptables \
        jq \
        less \
        locales \
        openssl \
        procps \
        squid-openssl \
        sudo \
        unzip \
        vim-tiny \
    && ln -sf /usr/bin/vim.tiny /usr/bin/vim \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen \
    && update-ca-certificates \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8

# Non-root developer user. The image is `node:*`, which already ships uid 1000
# as the `node` user — rename rather than recreate to avoid uid collisions on
# Linux hosts.
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=$USER_UID
RUN userdel --remove node 2>/dev/null || true \
    && groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m -s /bin/bash $USERNAME

# Persist shell history across container restarts.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
    && mkdir /commandhistory \
    && touch /commandhistory/.bash_history \
    && chown -R $USERNAME /commandhistory \
    && echo "$SNIPPET" >> /home/$USERNAME/.bashrc

# Workspace + per-user state directories.
RUN mkdir -p /workspace \
        /home/$USERNAME/.claude \
        /home/$USERNAME/.local/bin \
        /home/$USERNAME/.local/share/pnpm/store \
        /home/$USERNAME/.local/share/mise \
    && chown -R $USERNAME:$USERNAME /workspace /home/$USERNAME/.claude /home/$USERNAME/.local

WORKDIR /workspace

# Squid SSL bump cert + ssl_db. Not used for decryption — peek-and-splice only —
# but Squid still requires the cert to exist.
RUN mkdir -p /var/log/squid /var/spool/squid \
    && chown -R proxy:proxy /var/log/squid /var/spool/squid \
    && chmod 755 /var/log/squid \
    && openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
        -subj "/CN=squid-bump" \
        -keyout /etc/squid/bump.key -out /etc/squid/bump.crt \
    && chown proxy:proxy /etc/squid/bump.* && chmod 600 /etc/squid/bump.* \
    && /usr/lib/squid/security_file_certgen -c -s /var/spool/squid/ssl_db -M 4MB \
    && chown -R proxy:proxy /var/spool/squid/ssl_db

# Pnpm via corepack (project pins pnpm@10.33.2 in package.json). Run as
# root because corepack writes symlinks into /usr/local/bin.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

USER $USERNAME

# Allow git operations across worktree paths.
RUN git config --global --add safe.directory '*'

# mise — same task runner as the host, so `mise run typecheck` etc. work
# identically inside and outside the container.
ENV PATH=/home/$USERNAME/.local/bin:/home/$USERNAME/.local/share/mise/shims:$PATH \
    MISE_DATA_DIR=/home/$USERNAME/.local/share/mise
RUN curl -fsSL https://mise.run | sh \
    && echo 'eval "$(/home/dev/.local/bin/mise activate bash)"' >> /home/$USERNAME/.bashrc

# Claude Code: this devcontainer's reason for being. Installed inside so
# `--dangerously-skip-permissions` runs in the sandbox, not on the host.
ENV NPM_CONFIG_PREFIX=/home/$USERNAME/.local
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

ENV SHELL=/bin/bash \
    EDITOR=vim \
    VISUAL=vim

# Config + scripts copied late so earlier layers stay cached when allowlists change.
COPY setup/squid.conf /etc/squid/squid.conf
COPY allowed-domains.txt /etc/squid/allowed-domains.txt
COPY protected-paths.txt /etc/devcontainer/protected-paths.txt
COPY setup/init-firewall.sh setup/init-file-protection.sh /usr/local/bin/

USER root
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/init-file-protection.sh \
    && echo "$USERNAME ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/local/bin/init-file-protection.sh, /usr/bin/bash /workspace/.devcontainer/setup/init-file-protection.sh" \
        > /etc/sudoers.d/$USERNAME-firewall \
    && chmod 0440 /etc/sudoers.d/$USERNAME-firewall
USER $USERNAME

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sleep", "infinity"]
