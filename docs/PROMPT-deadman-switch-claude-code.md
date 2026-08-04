# Prompt para Claude Code — Dead-man's-switch del pipeline de auditoría SLA

> Repo: `vidal-renao/vidal-helpdesk-mcp` (NO el del dashboard).
> Objetivo en una frase: un monitor **externo e independiente** que avisa cuando el pipeline de auditoría **deja de entregar en silencio** — la clase de fallo exacta del incidente 4A.16.

---

## 1. Por qué existe (no lo pierdas de vista al diseñar)

Las aserciones de contrato que ya tiene el workflow `audit.yml` solo disparan **si el run se ejecuta y llega a la aserción**. No cubren:
- Que el cron **deje de dispararse** (p. ej. GitHub **deshabilita los workflows programados tras 60 días** de inactividad del repo — pasa de verdad).
- Que GitHub Actions esté caído.
- Que el workflow se borre/rompa antes de la aserción.

En todos esos casos **no hay run, no hay rojo, no hay nada** — y hoy solo te enterarías por la ausencia de un email. Este monitor convierte "ausencia silenciosa" en "alerta activa".

**Principio de diseño no negociable: independencia.** El detector no puede compartir el mismo modo de fallo que lo vigilado. Por eso:
- La señal de vida se emite **solo en entrega sana**, y la alerta la dispara un sistema **externo** a tu código.
- La alerta **NO** puede ir por Resend (Resend es parte de lo que vigilas → sería circular).

---

## 2. Enfoque recomendado — Heartbeat externo (healthchecks.io)

Patrón dead-man's-switch clásico: el trabajo sano hace "ping"; si el ping no llega en la ventana, un servicio externo alerta.

**Cambio en el código (lo hace Claude Code):**
En `.github/workflows/audit.yml`, **después** del step que valida el contrato (el que hace `exit 1` si `emailSent !== true` y `!== already_sent`), añade un último step que solo corre si todo fue sano:
```yaml
      - name: Heartbeat (dead-man's-switch)
        if: success()
        run: curl -fsS --retry 3 --max-time 10 "${{ secrets.HC_PING_URL }}"
```
Como los steps posteriores a un `exit 1` no se ejecutan, el ping **solo** ocurre en `delivered` o `already_sent`. Un run que no entrega → no hay ping → salta la alerta.

**Setup manual (lo haces tú, Claude Code te lo deja documentado en el README):**
1. Crea una check en healthchecks.io (free): `Period = 1 day`, `Grace = 4h` (absorbe la cola de GHA que retrasa el run de las 06:00 hasta media mañana). Ventana efectiva de alerta ≈ 28h.
2. Copia la Ping URL (`https://hc-ping.com/<uuid>`) y añádela como **secret** `HC_PING_URL` en el repo.
3. Configura el canal de alerta en healthchecks.io **distinto de Resend**: email de un buzón alternativo, Slack, o WhatsApp vía integración. Prueba con el botón de test del propio servicio.

**Qué cubre este patrón (matriz):**
- Cron no dispara / workflow deshabilitado por GitHub → sin ping → **alerta** ✅
- GitHub Actions caído → sin ping → **alerta** ✅
- Endpoint 500 / `claim_failed` → aserción `exit 1` → sin ping → **alerta** ✅
- Entrega sana → ping → silencio ✅

---

## 3. Alternativa — Monitor self-contained (si no quieres terceros)

Si prefieres cero dependencias externas, en su lugar crea un **segundo workflow** `.github/workflows/audit-watchdog.yml` con cron **desfasado** del principal (p. ej. `0 12 * * *`) que:
1. Consulta Supabase: `select max(created_at) from helpdesk.audit_runs where status = 'sent';`
2. Si `now() - max(created_at) > interval '26 hours'` → dispara alerta.
3. **Alerta por un canal que NO sea Resend:** abre un GitHub issue (`gh issue create` / API con `GITHUB_TOKEN`) **y/o** manda WhatsApp por la Cloud API de WAAI (WABA `${WAAI_WABA_ID}`, Phone Number ID `${WAAI_PHONE_NUMBER_ID}`).

> Los identificadores reales de WAAI van por env/secret del repo, nunca escritos en este repositorio: es público. Lo mismo aplica al access token de la Cloud API.

Usa un script Node/TS pequeño (`scripts/audit-watchdog.ts`) con las credenciales de Supabase por env (service_role, solo en el runner). **Debilidad conocida** (documéntala): comparte disponibilidad con GitHub Actions, así que no cubre "GHA caído". Por eso el heartbeat externo es el recomendado; esta opción es el plan B.

---

## 4. Integración opcional con el dashboard

Expón el estado en una tile del dashboard ("Pipeline health: última auditoría hace Xh", verde si < 26h, rojo si no). Dato server-side desde `public.audit_runs`. Marca esto como **opcional / fase 2** — no bloquea el monitor.

---

## 5. Criterios de aceptación

- [ ] Un run sano de `audit.yml` (dispatch manual) produce el ping (verifícalo en el log del check en healthchecks.io: pasa a "up").
- [ ] El botón de test del canal de alerta llega al destino elegido (y **no** es Resend).
- [ ] El step de heartbeat **no** corre cuando la aserción de contrato falla (revisa un run rojo histórico o fuerza el escenario).
- [ ] `HC_PING_URL` está como secret, no hardcodeado; no aparece en logs.
- [ ] README actualizado con el setup manual y la matriz de cobertura.

## 6. Fuera de alcance

- No toques la lógica de entrega ni el `AuditService` — solo añades el heartbeat al final del workflow.
- No cambies el cron `0 6 * * *` del audit principal.
