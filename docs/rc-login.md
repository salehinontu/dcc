# Signing an RC into the fleet console

How to connect a DJI RC Plus 2 to the running fleet console. This covers the account sign-in
on the `/pilot` page and the approval that follows it.

## Two different logins — do not mix them up

| Login | Where | Checked by | Purpose |
| --- | --- | --- | --- |
| DJI account (e.g. a personal Gmail) | Pilot 2 itself | DJI | Firmware, Pilot 2 features, Cloud API licence |
| Fleet-console account (a `pilot`-role account) | The `/pilot` form | Our API and Postgres | Requests a controller enrolment; the admin approval issues MQTT credentials |

The email and password on the `/pilot` form are **our** credentials. They are sent to
`POST /api/pilot/auth` and checked against the `users` table. DJI never sees them, so a DJI
account that works in Pilot 2 will still fail here if it has no fleet-console user.

The account must have the **drone operator** role. A dashboard `admin` or `viewer` account cannot bind
a controller — that restriction is what stops any signed-in user impersonating a gateway.

## Steps

1. On the RC, open Pilot 2 → **Cloud Services** → the **Drone Fleet** entry, which loads
   `https://fleet.example.com/pilot`.
   - Expected: the **Connect this controller** card with the Email / Password form.

2. Sign in with the `pilot`-role account.
   - The page then signs in (`/api/pilot/auth`), reads the DJI configuration with the
     short-lived token, verifies the licence, and reads the controller serial from Pilot 2.
   - If you see **Licence verification failed**, the App ID / App Key / Licence in
     `infra/.env.production` are wrong or missing — stop here, this is a server problem.

3. **First time only:** the card shows **Awaiting approval** with the controller serial.
   - Nothing is reported to the fleet in this state, and no MQTT credentials exist.
   - An administrator approves the controller in the dashboard (**Awaiting approval** block in
     the fleet rail) or from the server:
     ```bash
     $COMPOSE exec api pnpm controller:approve -- --sn <controller serial> --by '<admin email>'
     ```
   - Tap **Check approval** afterwards, or reload the page.

4. Once approved, the connection steps turn green in order — Account sign-in, DJI licence,
   Controller approval, Cloud API module, Telemetry link, Workspace, Live video — and the card
   changes to **Controller connected**.
   - The page then opens MQTT/TLS to `fleet.example.com:8883` using per-controller credentials
     (`gw_<serial>`) issued by `/api/pilot/user-info`. Keep this page open for the flight;
     closing it stops telemetry from this controller.

5. Open `https://fleet.example.com/` on a PC and sign in as an operator.
   - Expected: the controller appears online in the fleet list within about ten seconds, with
     telemetry and the camera feed available.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Sign-in failed — Email or password is incorrect** | Email not in `users`, or wrong password | Confirm the account with the `psql` query below; re-check symbols with the eye icon |
| **Sign-in failed — This account cannot bind a controller** | The account is `admin` or `viewer` | Use a `pilot`-role account (`pnpm --filter @dji/api user:create -- --role pilot`) |
| **Awaiting approval** | No admin has approved this serial yet | Approve it in the dashboard or with `controller:approve` |
| **Controller not approved** | The serial was rejected or unbound | Investigate before re-approving; the rejection is in the API audit log (`device_events`) |
| Login succeeds but the controller never shows online | MQTT blocked or credentials rejected | `docker logs --tail 50 dji-fleet-prod-api-1` and `docker logs --tail 50 dji-fleet-prod-emqx-1` |
| **Too many requests** | A rate limit was hit while retrying | Wait one minute and try again |

The API log records each attempt with its outcome. `POST /api/pilot/auth` followed by
`"statusCode":401` means the credentials were rejected; `POST /api/pilot/login` with `403` and
`code:2` means the controller is waiting for approval.

```bash
docker exec dji-fleet-prod-postgres-1 psql -U dji -d dji \
  -c 'select email, role from users;' \
  -c 'select controller_sn, status, approved_by from controller_enrollments;'
docker logs --since 30m dji-fleet-prod-api-1 2>&1 | grep -E 'pilot/(auth|login)|statusCode'
```
