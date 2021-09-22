#!/bin/bash
sed -e "s_'@models/utils/coordinates'_'./coordinates.ts'_g" ../../binaural-meet/src/models/MapObject.ts > MapObject.ts
sed -e "s_from './MapObject'_from './MapObject.ts'_g" -e "s_'@models/utils/coordinates'_'./coordinates.ts'_g" ../../binaural-meet/src/models/ISharedContent.ts > ISharedContent.ts
cp ../../binaural-meet/src/models/api/MessageType.ts .
cp ../../binaural-meet/src/models/utils/coordinates.ts .
