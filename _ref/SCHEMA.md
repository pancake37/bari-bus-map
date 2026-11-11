# Mobilita city JSON schema (from dovevannoinostrisoldi explorer)

Metric: scheduled-segment-travel-time
Method: median of scheduled adjacent-stop arrival minus departure; distance along GTFS shape; no dwell; no realtime

## City object keys
id, name, holder, landingUrl, mode, routeTypes, license, licenseUrl, cadence, focus[lon,lat],
mapBounds[minLon,minLat,maxLon,maxLat], studyBounds, url, serviceDate (YYYY-MM-DD),
receipt{}, maxStopOffsetMetres, status ("ready"|"no-service"), segments[], stops[],
exclusions{}, coverage{}, publicationVerdict, basemap{features,labels,receipt,attribution,license,licenseUrl}

## Segment
id, route, routeName, direction, fromId, toId, from, to, metres, coordinates[[lon,lat],...],
bands: { all|morning|day|evening: { samples, seconds, kmh } }, estimated (0/1)

Bands: morning=07-10, day=10-16, evening=16-20, all=full day. Use median seconds across samples.

## Stop
id, name, point[lon,lat]

## Basemap feature
id, kind, class, name, closed, coordinates[[lon,lat],...]

Reuse basemap from _ref/bari-upstream.json.gz (OSM). Regenerate segments/stops/status/coverage from local google_transit.zip.
Explorer loads cities/*.json.gz via fetch + DecompressionStream; manifest in <script id="data" type="application/json">.

