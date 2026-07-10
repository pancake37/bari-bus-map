# Bari AMTAB Realtime Bus Map

Interactive real-time map of AMTAB buses in Bari using official GTFS-RT feeds.  
Built with Leaflet + Node.js proxy server.

## Quick Start

```bash
node server.js
```

Open `http://localhost:3000`

Requires `google_transit.zip` in the project directory (GTFS static data from AMTAB).

## Architecture

```
server.js (Node.js http)
├── Proxy: AMTAB VehiclePosition / TripUpdates → /api/vehicles, /api/trip-updates
├── GTFS static extraction → /api/routes, /api/stops, /api/shapes, /api/stop-info
└── Static files → index.html

index.html (Leaflet)
├── Bus markers with route badge + delay color
├── Stops toggle with route list + arrival times
└── Auto-refresh every 10s
```

## Data Sources

| Feed | URL |
|------|-----|
| Vehicle Positions | `https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition` |
| Trip Updates | `https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates` |
| Static GTFS | Local `google_transit.zip` |

## Features

- Real-time bus positions with speed, delay, route number
- Color-coded delay: green (on time) → orange (≤10 min) → red (>10 min)
- Click a bus for vehicle ID, speed, delay
- Toggle stops layer, click a stop for serving routes + arrival times
- No external CORS proxies needed
