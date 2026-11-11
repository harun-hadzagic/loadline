#
# Loadline: native linux/arm64 build of postgis/postgis:18-3.6, for Apple Silicon.
# Copied from github.com/postgis/docker-postgis, 18-3.6/Dockerfile at commit
# ba86273c (MIT, see LICENSE.docker-postgis), with one change marked below.
# Build: pnpm db:image   (tags loadline/postgis:18-3.6)
#

FROM docker.io/postgres:18-trixie

LABEL maintainer="PostGIS Project - https://postgis.net" \
      org.opencontainers.image.description="PostGIS 3.6.4+dfsg-2.pgdg13+1 spatial database extension with PostgreSQL 18 trixie" \
      org.opencontainers.image.source="https://github.com/postgis/docker-postgis"

ENV POSTGIS_MAJOR=3
ENV POSTGIS_VERSION=3.6.4+dfsg-2.pgdg13+1

RUN apt-get update \
      && apt-cache showpkg postgresql-$PG_MAJOR-postgis-$POSTGIS_MAJOR \
      && apt-get install -y --no-install-recommends \
           # ca-certificates: for accessing remote raster files;
           #   fix: https://github.com/postgis/docker-postgis/issues/307
           ca-certificates \
           \
           postgresql-$PG_MAJOR-postgis-$POSTGIS_MAJOR=$POSTGIS_VERSION \
           # Loadline change: pin the scripts package too. Unpinned, apt picks the
           # 3.7.0 scripts, which refuse to load with the 3.6.4 library.
           postgresql-$PG_MAJOR-postgis-$POSTGIS_MAJOR-scripts=$POSTGIS_VERSION \
      && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /docker-entrypoint-initdb.d
COPY ./initdb-postgis.sh /docker-entrypoint-initdb.d/10_postgis.sh
COPY ./update-postgis.sh /usr/local/bin

