# Branding files

Put this installation's logo here (a square PNG, JPEG, WebP or SVG, at most 2 MB) and point
`BRAND_LOGO_PATH` in `infra/.env.production` at it, for example
`BRAND_LOGO_PATH=/data/branding/logo.png`. The production compose file mounts this folder
read-only into the API at `/data/branding`. Restart the api container after changing it.
