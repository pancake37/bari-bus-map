'use strict';

function getDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function dateToGtfsStr(date, timeZone = 'Europe/Rome') {
    const parts = getDateParts(date, timeZone);
    return parts.year + parts.month + parts.day;
}

function getActiveServiceIds(calendar, calendarDates, date, timeZone = 'Europe/Rome') {
    const active = new Set();
    const parts = getDateParts(date, timeZone);
    const dateStr = parts.year + parts.month + parts.day;
    const dayName = parts.weekday.toLowerCase();

    Object.keys(calendar || {}).forEach(serviceId => {
        const entry = calendar[serviceId];
        if (entry[dayName] === '1' && dateStr >= entry.start_date && dateStr <= entry.end_date) {
            active.add(serviceId);
        }
    });

    Object.keys(calendarDates || {}).forEach(key => {
        const [serviceId, exceptionDate] = key.split('|');
        if (exceptionDate !== dateStr) return;
        if (calendarDates[key] === '1') active.add(serviceId);
        else if (calendarDates[key] === '2') active.delete(serviceId);
    });

    return active;
}

function hasServiceCalendar(calendar, calendarDates) {
    return Object.keys(calendar || {}).length > 0 || Object.keys(calendarDates || {}).length > 0;
}

function rebuildRouteShapes(tripShapes, tripRouteIds, serviceIdMap, activeSids) {
    const routeShapes = {};
    Object.keys(tripShapes || {}).forEach(tripId => {
        if (activeSids) {
            const serviceId = serviceIdMap[tripId];
            if (!serviceId || !activeSids.has(serviceId)) return;
        }
        const shapeId = tripShapes[tripId];
        const routeId = tripRouteIds[tripId];
        if (!shapeId || !routeId) return;
        if (!routeShapes[routeId]) routeShapes[routeId] = [];
        if (!routeShapes[routeId].includes(shapeId)) routeShapes[routeId].push(shapeId);
    });
    return routeShapes;
}

function rebuildStopInfo(stopTimes, serviceIdMap, activeSids) {
    const stopInfo = {};
    Object.keys(stopTimes || {}).forEach(stopId => {
        const byRoute = {};
        stopTimes[stopId].forEach(trip => {
            if (activeSids && !activeSids.has(serviceIdMap[trip.trip_id])) return;
            if (!byRoute[trip.route_id]) {
                byRoute[trip.route_id] = { route_id: trip.route_id, arrivals: [], headsign: trip.headsign };
            }
            if (trip.arrival) byRoute[trip.route_id].arrivals.push(trip.arrival);
        });
        const routes = Object.values(byRoute);
        routes.forEach(route => {
            route.arrivals.sort();
            route.next = route.arrivals.slice(0, 3);
            delete route.arrivals;
        });
        if (routes.length) stopInfo[stopId] = routes;
    });
    return stopInfo;
}

module.exports = { dateToGtfsStr, getActiveServiceIds, hasServiceCalendar, rebuildRouteShapes, rebuildStopInfo };
