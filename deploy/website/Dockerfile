ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine
FROM ${NGINX_IMAGE}
COPY --chown=101:101 nginx.conf /etc/nginx/nginx.conf
COPY --chown=101:101 security-headers.conf /etc/nginx/security-headers.conf
COPY --chown=101:101 site/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
