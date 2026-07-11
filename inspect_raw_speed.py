import urllib.request
import json

url = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition'

try:
    with urllib.request.urlopen(url) as response:
        data = json.loads(response.read().decode('utf-8'))
        entities = data.get("Entity", data.get("Entities", []))
        print("Number of vehicles in raw feed:", len(entities))
        count = 0
        for e in entities:
            veh = e.get("Vehicle")
            if veh and veh.get("Position"):
                pos = veh["Position"]
                speed = pos.get("Speed")
                if speed is not None and speed > 0:
                    print(f"Vehicle {e.get('Id')}: Speed = {speed}, Lat = {pos.get('Latitude')}, Lon = {pos.get('Longitude')}")
                    count += 1
                    if count >= 10:
                        break
except Exception as e:
    print("Error:", e)
