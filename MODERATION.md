# Moderación — reportes de hospedaje/Airbnb

Todo reporte que identifica a una persona por nombre (categoría `hospedaje` por ahora,
cualquier categoría futura que use `report_subjects` mañana) entra con `status='pending'`
y **nunca se auto-publica**. Este es el checklist para revisarlo a mano en Supabase Studio
(no hay panel dedicado en esta v1 — se justifica solo si hay volumen real).

## 1. Encontrar reportes pendientes

Supabase Studio → Table Editor → `reports` → filtro `status = pending` y
`category = hospedaje` (o revisa el correo de alerta que llega a `ALERT_EMAIL` cada vez
que entra uno nuevo, con el nombre y si ya hay corroboración).

## 2. Revisar el caso

- Tabla `report_subjects`, filtro `report_id = <id>` → nombre reportado y link del anuncio.
- Tabla `report_evidence`, filtro `report_id = <id>` → `storage_path_private` (si hay imagen).
- Lee la descripción. ¿Es un hecho concreto y verificable, o una queja genérica/ataque personal?
- ¿Hay otro reporte publicado con el mismo nombre (corroboración)? El correo de alerta ya te
  lo dice; si no, consulta `named_report_confidence` con ese `value_normalized`.

## 3. Si hay imagen: redactar ANTES de publicar

**Nunca subas el original al bucket público.** Pasos:
1. Descarga el original desde `evidence-private` (Storage → ese bucket, esa ruta) — solo tú
   tienes acceso, por diseño.
2. Recorta al fragmento relevante (el mensaje/conversación que sustenta el reporte).
3. Difumina/tapa: caras, teléfonos, nombres de terceros no reportados, direcciones, datos de pago.
4. Quita metadata EXIF (cualquier editor de imágenes lo hace al re-exportar, o `exiftool -all= archivo.jpg`).
5. Sube el resultado a `evidence-public` con un nombre nuevo (ej. `published/<report_id>.jpg`).
6. Actualiza `report_evidence.storage_path_public_derivative` con esa ruta y marca
   `exif_stripped = true`.

## 4. Publicar

`update reports set status = 'published' where id = '<id>'` (SQL Editor o Table Editor).

Si decides que NO se publica (reporte sin sustento, ataque personal, no verificable):
déjalo en `pending` — no hace falta borrarlo, es evidencia de que el sistema funciona.

## 5. "Soy la persona nombrada" — SLA de 72 horas

Los correos a `contacto@radarurbano.org` con asunto "Soy la persona nombrada..." se
responden en máximo 72 horas. Si la persona da contexto que cambia el caso (ej. la otra
parte también incumplió, hay evidencia contraria), puedes:
- Revertir a `pending` un reporte ya publicado (mismo UPDATE de arriba, al revés).
- Pedir al reportante evidencia adicional antes de decidir.

## 6. Expiración automática

Un cron (`expire_uncorroborated_named_reports`, corre diario a las 8am UTC) oculta solo
los reportes con nombre que llevan 90+ días publicados y nunca recibieron un segundo
reporte del mismo nombre. No se borra nada — vuelve a `pending`, republicable a mano
si más tarde aparece corroboración.
