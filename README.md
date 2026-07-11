# Bari AMTAB Real-time Bus Map

An interactive, real-time map of AMTAB city buses in Bari, Italy, utilizing official GTFS-Realtime feeds. Replicates the premium visual identity and features of the **Transit App**, including custom dark basemaps, live stops timelines, delay status badges, and advanced direction-aware route path splitting.

## Features

- **Advanced Travel Time Prediction**: Computes downstream stop ETAs in real-time using a segment-based travel speed model. It weights the bus's instantaneous speed near stops and uses historical averages (adjusted for rush-hour traffic and deceleration zones) for downstream segments.
- **Transit App UI styling**: Elegant dark interface with large, bold, route-colored typography, real-time tracking badges (`📶`), and live timelines.
- **Live Stop Timeline**: Clicking any vehicle marker on the map displays its ordered timeline of stops, greying out passed stops and highlighting upcoming ones with real-time ETAs.
- **Direction-Aware Split Route Paths**: Selecting a route draws a custom path showing exactly where the bus has been (thin, faded line) versus where it is going (thick, high-contrast line), aligned to the vehicle's active trip direction.
- **Minimalist Dark Map**: Powered by CartoDB Dark Matter tiles, removing POIs and distracting labels to focus entirely on roads, stops, and vehicles.
- **Dynamic Performance**: Large GTFS shapes data (13+ MB) are fetched dynamically only when a route is clicked, keeping startup load times under 50 milliseconds.

## Quick Start

1. Place the local static GTFS archive `google_transit.zip` in the root directory.
2. Start the proxy and estimation server:
   ```bash
   node server.js
   ```
3. Open `http://localhost:3000` in your browser.

## Architecture

```
server.js (Node.js HTTP Server)
├── GTFS Static Parser (Runs on startup, caches stop shapes and route graphs)
├── Proxy Endpoint (/api/vehicles, /api/trip-updates)
├── Estimation Engine (/api/etas: predicts segment-by-segment stop times)
└── Query API (/api/shapes?id=X, /api/shape-stops)

index.html (Client App using Leaflet.js)
├── CartoDB Dark Matter tile layer
├── Stop markers & vehicle markers with real-time updates
├── Stop Details sidebar (serving routes & ETAs)
└── Vehicle Details sidebar (stops list, vertical timeline, delay status)
```

## Data Sources

| Feed | URL | Type |
|------|-----|------|
| Vehicle Positions | `https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition` | GTFS-RT |
| Trip Updates | `https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates` | GTFS-RT |
| Static GTFS | Local `google_transit.zip` | Static GTFS zip |
