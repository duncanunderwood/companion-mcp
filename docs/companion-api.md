# Bitfocus Companion 5.0.7 HTTP API reference

Ground truth for this project. If an endpoint is not listed here it must not be used.

Sources:

- `docs/user-guide/5_remote-control/http-remote-control.md` at tag `v5.0.7`
- `companion/lib/Service/HttpApi.ts` at tag `v5.0.7` (for exact status codes and response bodies)

## Prerequisites

- The HTTP API must be enabled in Companion: Settings, HTTP, "HTTP API" (userconfig key `http_api_enabled`). When disabled every `/api/*` route returns `403` with an empty body.
- Default port is `8000`. Confirm in Settings, "Admin UI port".
- Base URL example: `http://127.0.0.1:8000`
- All endpoints live under `/api`. Unknown `/api/*` paths return `404` with an empty body.

## Location parameters

Buttons are addressed by `page`, `row`, `column`.

- `page`: integer, 1 to 99
- `row`: integer, 0 based. Default grid is 4 rows (0 to 3) but the grid can be enlarged in Settings. Negative values are possible on a resized grid, but this project restricts to 0 to 31.
- `column`: integer, 0 based. Default grid is 8 columns (0 to 7). This project restricts to 0 to 31.

Companion parses these with `Number()`, so they must be plain integers.

## Button control (write)

All of these are `POST` and return `200` body `ok` on success.

If there is no button configured at the location: `204` body `No control`.

| Action                             | Method | Path                                                |
| ---------------------------------- | ------ | --------------------------------------------------- |
| Press and release (down then up)   | POST   | `/api/location/<page>/<row>/<column>/press`         |
| Press and hold (down actions only) | POST   | `/api/location/<page>/<row>/<column>/down`          |
| Release (up actions only)          | POST   | `/api/location/<page>/<row>/<column>/up`            |
| Rotate encoder left                | POST   | `/api/location/<page>/<row>/<column>/rotate-left`   |
| Rotate encoder right               | POST   | `/api/location/<page>/<row>/<column>/rotate-right`  |
| Set current step                   | POST   | `/api/location/<page>/<row>/<column>/step?step=<n>` |

`step` returns `400` body `Bad step` if the step is invalid for the control.

Example: press page 1, row 0, column 2

```
POST /api/location/1/0/2/press
-> 200 ok
```

## Button style (write)

| Action                  | Method | Path                                                                                                                            |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Set style via query     | POST   | `/api/location/<page>/<row>/<column>/style?text=<text>&bgcolor=<hex>&color=<hex>&size=<n>`                                      |
| Set style via JSON body | POST   | `/api/location/<page>/<row>/<column>/style` with body `{ "text": "...", "bgcolor": "#rrggbb", "color": "#rrggbb", "size": 28 }` |

Colours accept `#rrggbb` or `rgb(r,g,b)`. `size` accepts a number or `"auto"`.
Returns `200` body `ok`, or `204` body `No control` if no button exists at the location.

This project does not implement style changes in the first version.

## Custom variables

### Get custom variable value (read)

```
GET /api/custom-variable/<name>/value
```

- `200`: body is the value. Strings are sent as text. Numbers are sent as their string form. Objects and arrays are sent as JSON.
- `404` body `Not found`: variable does not exist.

### Set custom variable value (write)

Three forms are accepted:

1. Query string: `POST /api/custom-variable/<name>/value?value=<value>`
2. Plain text body: `POST /api/custom-variable/<name>/value` with `Content-Type: text/plain` and the raw value as the body. The value is trimmed.
3. JSON body: `POST /api/custom-variable/<name>/value` with `Content-Type: application/json`. A JSON string must be quoted (`"Some text"`). Objects, arrays, numbers, booleans and null are stored as typed values. An empty body is interpreted as `undefined`.

Responses:

- `200` body `ok`
- `400` body `No value`: no value could be read from query or body
- `404` body `Not found`: variable does not exist

This project uses form 2 (plain text body) so that values are never placed in a URL.

## Module (connection) variables

### Get module variable value (read)

```
GET /api/variable/<connection label>/<variable name>/value
```

- `200`: body is the value, same encoding rules as custom variables
- `404` body `Not found`: connection or variable does not exist

## Connections

### List connections (read)

```
GET /api/connections
```

`200` JSON array:

```json
[
  {
    "id": "abc123",
    "label": "My OBS",
    "moduleId": "obs-websocket",
    "enabled": true,
    "sortOrder": 0,
    "status": { "category": "good", "level": "ok", "message": "Connected" }
  }
]
```

### Get connection status (read)

```
GET /api/connections/<id>/status
```

`200`:

```json
{
  "id": "abc123",
  "label": "My OBS",
  "enabled": true,
  "status": { "category": "good", "level": "ok", "message": "Connected" }
}
```

`404`: `{ "status": 404, "message": "Connection not found" }`

### Restart, enable, disable connection (write)

| Action  | Method | Path                            | 200 body                                             |
| ------- | ------ | ------------------------------- | ---------------------------------------------------- |
| Restart | POST   | `/api/connections/<id>/restart` | `{ "id": "abc123", "message": "Restart triggered" }` |
| Enable  | POST   | `/api/connections/<id>/enable`  | `{ "id": "abc123", "enabled": true }`                |
| Disable | POST   | `/api/connections/<id>/disable` | `{ "id": "abc123", "enabled": false }`               |

Errors: `404` connection not found. Restart also returns `409` `{ "status": 409, "message": "Connection is inactive and cannot be restarted" }`.

This project does not implement connection restart, enable or disable in the first version.

## Surfaces

```
POST /api/surfaces/rescan
```

`200` body `ok`, or `500` body `fail`. Not implemented in this project.

## Deprecated legacy endpoints (do not use)

`/press/bank/...`, `/style/bank/...`, `/set/custom-variable/...`, `/rescan`. These require a separate legacy setting and will be removed. This project must never call them.

## Behaviour notes

- The API is fire and forget for presses. A `200 ok` means Companion accepted the request, not that the downstream action succeeded. Confirm state by reading variables back.
- A press request runs the down actions, waits briefly, then runs the up actions server side. There is no way to know from the response whether the actions completed.
- Companion does not implement request authentication on this API. Network placement is the only access control.
